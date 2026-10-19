import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Bridge, delegationDepth, workerEnv } from '../src/service.js';
import { config, discoverCodex, type Config } from '../src/config.js';
import { BridgeError, type Conversation, type Run } from '../src/types.js';

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function tempRoot() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-bridge-codex-')));
  roots.push(root);
  return root;
}
const code = (expected: string) => (error: unknown) => error instanceof BridgeError && error.code === expected;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
class Clock { t = 1_000; now = () => this.t; }
const settingsFor = (stateDir: string, extra: Partial<Config> = {}): Config => ({ stateDir, executable: 'claude-fixture', maxActive: 1, staleMs: 120_000, ...extra });

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  apply(vars);
  try { fn(); } finally { apply(saved); }
}

// The schema shipped as user_version 1, verbatim.
const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  ord INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  cwd TEXT NOT NULL,
  source_cwd TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('review', 'write')),
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  base_commit TEXT,
  branch TEXT,
  session_initialized INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  ord INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  request_key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'needs_input', 'succeeded', 'failed', 'cancelled', 'unknown')),
  timeout_ms INTEGER NOT NULL,
  max_turns INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  worker_token TEXT,
  worker_pid INTEGER,
  worker_identity TEXT,
  heartbeat_at INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error_code TEXT,
  ack_unknown_through INTEGER
);
CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id, created_at, ord);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
CREATE TABLE IF NOT EXISTS permissions (
  ord INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(id),
  tool TEXT NOT NULL,
  input TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'allow', 'deny', 'expired')),
  answers TEXT,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS permissions_one_pending ON permissions(run_id) WHERE decision = 'pending';
PRAGMA user_version = 1;
`;

test('a version 1 ledger migrates in place, keeps Claude identity and accepts exact old retries', () => {
  const root = tempRoot(), dir = join(root, 'state');
  mkdirSync(dir);
  const conversationId = randomUUID(), runId = randomUUID();
  const oldInput = { requestKey: 'legacy-key', prompt: 'Legacy review', cwd: root, effort: 'high' };
  // Version 1 fingerprinted the parsed input, keys in schema order.
  const oldFingerprint = sha({ requestKey: 'legacy-key', prompt: 'Legacy review', cwd: root, effort: 'high' });
  const v1 = new DatabaseSync(join(dir, 'bridge.sqlite'));
  v1.exec(V1_SCHEMA);
  v1.prepare(`INSERT INTO conversations (id, cwd, source_cwd, mode, model, effort, session_initialized, created_at)
    VALUES (?, ?, ?, 'review', 'claude-opus-5-5', 'high', 1, 1000)`).run(conversationId, root, root);
  v1.prepare(`INSERT INTO runs (id, conversation_id, request_key, fingerprint, prompt, model, effort, status, timeout_ms, max_turns,
      created_at, updated_at, finished_at, result)
    VALUES (?, ?, 'legacy-key', ?, 'Legacy review', 'claude-opus-5-5', 'high', 'succeeded', 1800000, 30, 1000, 1000, 1000, 'legacy result')`)
    .run(runId, conversationId, oldFingerprint);
  v1.close();

  const store = new Store(dir);
  try {
    const c = store.getConversation(conversationId);
    assert.deepEqual([c.runtime, c.nativeId, c.model, c.effort, c.sessionInitialized], ['claude', null, 'claude-opus-5-5', 'high', true]);
    assert.equal(store.getRun(runId).result, 'legacy result');
  } finally { store.close(); }
  new Store(dir).close(); // Reopening a migrated ledger is a no-op.

  const db = new DatabaseSync(join(dir, 'bridge.sqlite'));
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.match(String(db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'conversations_native'`).get()?.sql), /UNIQUE INDEX .*\(runtime, native_id\)/);
    assert.throws(() => db.prepare(`UPDATE conversations SET runtime = 'other'`).run(), /CHECK constraint/);
  } finally { db.close(); }

  // No runtime is installed: a retry still returns its saved receipt without launching.
  let launches = 0;
  const bridge = new Bridge(settingsFor(dir, { executable: '' }), () => { launches++; });
  try {
    const retry = bridge.start(oldInput);
    assert.deepEqual([retry.created, retry.run.id, retry.run.status, retry.conversation.runtime], [false, runId, 'succeeded', 'claude']);
    assert.equal(launches, 0);
    assert.throws(() => bridge.start({ ...oldInput, effort: 'max' }), code('idempotency_conflict'));
  } finally { bridge.close(); }

  const newer = new DatabaseSync(join(dir, 'bridge.sqlite'));
  newer.exec('PRAGMA user_version = 3');
  newer.close();
  assert.throws(() => new Store(dir), code('schema_too_new'));
});

test('requests without runtime keep their version 1 fingerprint, Claude defaults and Claude effort enum', () => {
  const root = tempRoot();
  const bridge = new Bridge(settingsFor(join(root, 'state')), () => {});
  try {
    const key = randomUUID();
    const fields = { requestKey: key, prompt: 'Review fixture', cwd: root, model: 'claude-opus-5-5', effort: 'max', maxTurns: 5 };
    const first = bridge.start(fields);
    assert.equal(bridge.store.findByRequestKey(key)!.fingerprint, sha(fields));
    assert.equal(bridge.start(fields).created, false);

    const plain = bridge.start({ requestKey: randomUUID(), prompt: 'Defaults', cwd: root });
    assert.deepEqual([plain.conversation.runtime, plain.conversation.nativeId, plain.conversation.model, plain.conversation.effort],
      ['claude', null, 'claude-opus-5-5', 'high']);
    assert.equal(plain.run.maxTurns, 30);
    assert.throws(() => bridge.start({ requestKey: randomUUID(), prompt: 'x', cwd: root, effort: 'minimal' }), code('invalid_effort'));
    assert.throws(() => bridge.start({ requestKey: randomUUID(), prompt: 'x', conversationId: first.conversation.id, effort: 'minimal' }), code('invalid_effort'));

    // Runtime is fixed at creation: a follow-up may restate it, never change it.
    assert.throws(() => bridge.start({ requestKey: randomUUID(), prompt: 'x', conversationId: first.conversation.id, runtime: 'codex' }), code('immutable_conversation'));
    const restated = bridge.start({ requestKey: randomUUID(), prompt: 'Continue', conversationId: first.conversation.id, runtime: 'claude' });
    assert.deepEqual([restated.created, restated.conversation.id], [true, first.conversation.id]);
  } finally { bridge.close(); }
});

test('a Codex-only service starts Codex conversations with native defaults and refuses unsupported options', () => {
  const root = tempRoot();
  const launched: Run[] = [];
  const bridge = new Bridge(settingsFor(join(root, 'state'), { executable: '', codexExecutable: '/fixture/codex' }), run => { launched.push(run); });
  try {
    const first = bridge.start({ requestKey: randomUUID(), prompt: 'Review', cwd: root, runtime: 'codex' });
    const c = first.conversation;
    assert.deepEqual([c.runtime, c.nativeId, c.model, c.effort, c.sessionInitialized], ['codex', null, 'default', 'default', false]);
    assert.deepEqual([first.run.model, first.run.effort, launched.length], ['default', 'default', 1]);

    assert.throws(() => bridge.start({ requestKey: randomUUID(), prompt: 'x', cwd: root }), code('cli_missing'));
    assert.throws(() => bridge.start({ requestKey: randomUUID(), prompt: 'x', cwd: root, runtime: 'codex', maxTurns: 3 }), code('unsupported_option'));
    assert.throws(() => bridge.start({ requestKey: randomUUID(), prompt: 'x', conversationId: c.id, maxTurns: 3 }), code('unsupported_option'));
    assert.throws(() => bridge.start({ requestKey: randomUUID(), prompt: 'x', conversationId: c.id, runtime: 'claude' }), code('immutable_conversation'));
    assert.throws(() => bridge.start({ requestKey: randomUUID(), prompt: 'x', conversationId: c.id, effort: 'not a level' }), { name: 'ZodError' });

    const followup = bridge.start({ requestKey: randomUUID(), prompt: 'More', conversationId: c.id, model: 'gpt-fixture', effort: 'minimal' });
    assert.deepEqual([followup.run.model, followup.run.effort, followup.conversation.model], ['gpt-fixture', 'minimal', 'default']);
    assert.equal(launched.length, 2);
  } finally { bridge.close(); }

  const claudeOnly = new Bridge(settingsFor(join(root, 'state')), () => {});
  try {
    assert.throws(() => claudeOnly.start({ requestKey: randomUUID(), prompt: 'x', cwd: root, runtime: 'codex' }), code('cli_missing'));
  } finally { claudeOnly.close(); }
});

test('delegated processes cannot start nested runs; launched workers carry the Codex path and depth', () => {
  const root = tempRoot();
  assert.equal(delegationDepth({}), 0);
  assert.equal(delegationDepth({ AGENT_BRIDGE_DELEGATION_DEPTH: '0' }), 0);
  assert.equal(delegationDepth({ AGENT_BRIDGE_DELEGATION_DEPTH: '2' }), 2);
  assert.equal(delegationDepth({ AGENT_BRIDGE_DELEGATION_DEPTH: 'garbage' }), Infinity);
  let launches = 0;
  const bridge = new Bridge(settingsFor(join(root, 'state'), { codexExecutable: '/fixture/codex' }), () => { launches++; });
  try {
    withEnv({ AGENT_BRIDGE_DELEGATION_DEPTH: '1' }, () => {
      assert.throws(() => bridge.start({ requestKey: randomUUID(), prompt: 'x', cwd: root, runtime: 'codex' }), code('delegation_loop'));
    });
    assert.equal(launches, 0);
    withEnv({ AGENT_BRIDGE_DELEGATION_DEPTH: '0' }, () => { bridge.start({ requestKey: randomUUID(), prompt: 'x', cwd: root }); });
    assert.equal(launches, 1);
  } finally { bridge.close(); }

  const env = workerEnv(settingsFor('/state', { codexExecutable: '/fixture/codex' }), { KEEP: 'yes' });
  assert.deepEqual([env.KEEP, env.AGENT_BRIDGE_HOME, env.AGENT_BRIDGE_CLAUDE_PATH, env.AGENT_BRIDGE_CODEX_PATH, env.AGENT_BRIDGE_DELEGATION_DEPTH],
    ['yes', '/state', 'claude-fixture', '/fixture/codex', '1']);
  assert.ok(!('AGENT_BRIDGE_CODEX_PATH' in workerEnv(settingsFor('/state'), {})));
});

test('configuration discovers Codex without requiring Claude', () => {
  const root = tempRoot(), bin = join(root, 'bin'), empty = join(root, 'empty');
  mkdirSync(bin); mkdirSync(empty);
  const codex = join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex');
  writeFileSync(codex, '');
  const base = { AGENT_BRIDGE_CLAUDE_PATH: undefined, AGENT_BRIDGE_CODEX_PATH: undefined, AGENT_BRIDGE_MAX_ACTIVE: undefined, AGENT_BRIDGE_HOME: join(root, 'state') };
  withEnv({ ...base, PATH: bin }, () => {
    const found = config(false);
    assert.deepEqual([found.executable, found.codexExecutable], ['', codex]);
    assert.equal(config('codex').codexExecutable, codex);
    assert.throws(() => config(), code('cli_missing'));
    assert.throws(() => config('claude'), code('cli_missing'));
  });
  withEnv({ ...base, PATH: empty }, () => {
    assert.equal('codexExecutable' in config(false), false);
    assert.throws(() => config('codex'), code('cli_missing'));
  });
  withEnv({ ...base, PATH: empty, AGENT_BRIDGE_CODEX_PATH: codex }, () => { assert.equal(config('codex').codexExecutable, codex); });

  // POSIX: only a regular file named codex on PATH. (Windows host paths contain the POSIX delimiter.)
  if (process.platform !== 'win32') {
    const dirOnly = join(root, 'dir-only');
    mkdirSync(join(dirOnly, 'codex'), { recursive: true });
    assert.equal(discoverCodex(dirOnly, 'linux', 'x64'), undefined);
    assert.equal(discoverCodex(`${dirOnly}:${bin}`, 'linux', 'x64'), join(bin, 'codex'));
  }
});

test('Windows discovery resolves npm-installed native codex.exe without running the cmd shim', () => {
  const root = tempRoot(), npm = join(root, 'npm'), direct = join(root, 'direct');
  const triple = 'x86_64-pc-windows-msvc';
  const nested = join(npm, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', triple, 'codex');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'codex.exe'), '');
  assert.equal(discoverCodex(npm, 'win32', 'x64'), undefined, 'package files are trusted only beside an npm codex.cmd shim');
  writeFileSync(join(npm, 'codex.cmd'), '@echo off\r\n');
  assert.equal(discoverCodex(npm, 'win32', 'x64'), join(nested, 'codex.exe'));
  assert.equal(discoverCodex(npm, 'win32', 'ia32'), undefined);

  const vendored = join(npm, 'node_modules', '@openai', 'codex', 'vendor', triple, 'codex');
  mkdirSync(vendored, { recursive: true });
  writeFileSync(join(vendored, 'codex.exe'), '');
  assert.equal(discoverCodex(npm, 'win32', 'x64'), join(vendored, 'codex.exe'));

  // PATH order wins; a directly installed codex.exe is used as is.
  mkdirSync(direct);
  writeFileSync(join(direct, 'codex.exe'), '');
  assert.equal(discoverCodex(`${direct};${npm}`, 'win32', 'x64'), join(direct, 'codex.exe'));
  assert.equal(discoverCodex(`${npm};${direct}`, 'win32', 'x64'), join(vendored, 'codex.exe'));
});

const codexConversation = (model = 'default', effort = 'default'): Conversation => ({
  id: randomUUID(), runtime: 'codex', nativeId: null, cwd: '/work', sourceCwd: '/src', mode: 'review', model, effort,
  baseCommit: null, branch: null, sessionInitialized: false, createdAt: 1_000,
});
function claimed(store: Store, c: Conversation, model = c.model, effort = c.effort, claim = true) {
  const { run } = store.createRun({ conversation: c, requestKey: randomUUID(), fingerprint: 'fp', prompt: 'p', model, effort, timeoutMs: 60_000, maxTurns: 30 });
  const token = randomUUID();
  assert.equal(store.attachWorker(run.id, token, process.pid), true);
  if (claim) assert.equal(store.claimRun(run.id, token, 4), true);
  return { id: run.id, token };
}

test('native session binding is a lease-fenced compare-and-swap that records applied defaults', () => {
  const clock = new Clock(), store = new Store(join(tempRoot(), 'state'), clock.now);
  try {
    const c = codexConversation();
    const queued = claimed(store, c, 'default', 'default', false);
    assert.throws(() => store.bindNativeSession(queued.id, queued.token, 'thread-1', 'gpt-a', 'medium'), code('invalid_state'));
    assert.equal(store.claimRun(queued.id, queued.token), true);
    const w = queued;
    assert.throws(() => store.bindNativeSession(w.id, 'intruder', 'thread-1', 'gpt-a', 'medium'), code('lease_lost'));
    assert.throws(() => store.bindNativeSession(w.id, w.token, ' ', 'gpt-a', 'medium'), code('invalid_argument'));
    assert.throws(() => store.bindNativeSession(w.id, w.token, 'thread-1', '', 'medium'), code('invalid_argument'));
    assert.throws(() => store.bindNativeSession('missing', w.token, 'thread-1', 'gpt-a', 'medium'), code('not_found'));
    assert.equal(store.getConversation(c.id).nativeId, null);

    const bound = store.bindNativeSession(w.id, w.token, 'thread-1', 'gpt-a', 'medium');
    assert.deepEqual([bound.nativeId, bound.model, bound.effort, bound.sessionInitialized], ['thread-1', 'gpt-a', 'medium', true]);
    assert.deepEqual([store.getRun(w.id).model, store.getRun(w.id).effort], ['gpt-a', 'medium']);
    // Same identity again is idempotent and does not repin.
    assert.deepEqual(store.bindNativeSession(w.id, w.token, 'thread-1', 'gpt-b', 'high'), bound);
    assert.throws(() => store.bindNativeSession(w.id, w.token, 'thread-2', 'gpt-a', 'medium'), code('session_identity_changed'));
    assert.equal(store.getConversation(c.id).nativeId, 'thread-1');

    // A native session belongs to one conversation per runtime.
    const other = codexConversation(), o = claimed(store, other);
    assert.throws(() => store.bindNativeSession(o.id, o.token, 'thread-1', 'gpt-a', 'medium'), code('session_identity_changed'));
    assert.equal(store.getConversation(other.id).nativeId, null);
    const claude: Conversation = { ...codexConversation('claude-opus-5-5', 'high'), runtime: 'claude' }, k = claimed(store, claude);
    assert.equal(store.bindNativeSession(k.id, k.token, 'thread-1', 'claude-opus-5-5', 'high').nativeId, 'thread-1');

    assert.equal(store.finishRun(w.id, w.token, 'succeeded', 'ok'), true);
    assert.throws(() => store.bindNativeSession(w.id, w.token, 'thread-1', 'gpt-a', 'medium'), code('lease_lost'));
    // A follow-up inherits the pinned values.
    const next = claimed(store, store.getConversation(c.id));
    assert.deepEqual([store.getRun(next.id).model, store.getRun(next.id).effort], ['gpt-a', 'medium']);

    // Reconcile fencing wins over a late bind.
    const lostConversation = codexConversation(), lost = claimed(store, lostConversation);
    clock.t += 10_000;
    for (const live of [o, k, next]) store.heartbeat(live.id, live.token);
    assert.equal(store.reconcile(clock.t - 1), 1);
    assert.equal(store.getRun(lost.id).status, 'unknown');
    assert.throws(() => store.bindNativeSession(lost.id, lost.token, 'thread-lost', 'gpt-a', null), code('lease_lost'));
    assert.equal(store.getConversation(lostConversation.id).nativeId, null);

    // Explicit run choices are kept; only a native default requested by this run pins the conversation.
    const explicit = codexConversation(), e = claimed(store, explicit, 'gpt-explicit', 'default');
    const kept = store.bindNativeSession(e.id, e.token, 'thread-e', 'gpt-explicit', null);
    assert.deepEqual([kept.model, kept.effort], ['default', 'default']);
    assert.deepEqual([store.getRun(e.id).model, store.getRun(e.id).effort], ['gpt-explicit', 'default']);
  } finally { store.close(); }
});

test('Codex questions use exact question text, and server-resolved requests expire atomically', () => {
  const store = new Store(join(tempRoot(), 'state'));
  try {
    const w = claimed(store, codexConversation());
    const questions = { questions: [{ id: 'q1', header: 'Colour', question: 'Which colour?', isOther: true, isSecret: false, options: null }] };
    const q = store.requestPermission(w.id, w.token, 'codex.userInput', questions, 'question');
    assert.throws(() => store.answerPermission(q.id, 'allow'), code('answers_required'));
    assert.throws(() => store.answerPermission(q.id, 'allow', { q1: 'blue' }), code('answers_required'));
    assert.throws(() => store.answerPermission(q.id, 'deny', { 'Which colour?': 'blue' }), code('invalid_argument'));
    store.answerPermission(q.id, 'allow', { 'Which colour?': 'blue' });
    assert.deepEqual(store.consumePermission(q.id, w.token)?.answers, { 'Which colour?': 'blue' });

    const p = store.requestPermission(w.id, w.token, 'codex.commandExecution', { command: 'ls' }, 'command');
    assert.throws(() => store.expirePermission(p.id, 'intruder'), code('lease_lost'));
    assert.throws(() => store.expirePermission('missing'), code('not_found'));
    assert.equal(store.expirePermission(p.id, w.token).decision, 'expired');
    assert.equal(store.getRun(w.id).status, 'running');
    assert.deepEqual(store.pendingPermissions(w.id), []);
    assert.throws(() => store.answerPermission(p.id, 'allow'), code('permission_closed'));
    assert.throws(() => store.consumePermission(p.id, w.token), code('permission_consumed'));
    assert.equal(store.expirePermission(p.id).decision, 'expired');

    // An answer the runtime can no longer receive is never delivered, and the run resumes.
    const answered = store.requestPermission(w.id, w.token, 'codex.commandExecution', { command: 'pwd' }, 'command');
    store.answerPermission(answered.id, 'allow');
    assert.equal(store.expirePermission(answered.id, w.token).decision, 'allow');
    assert.equal(store.getRun(w.id).status, 'running');
    assert.throws(() => store.consumePermission(answered.id, w.token), code('permission_consumed'));

    // A finished run is never revived.
    const late = store.requestPermission(w.id, w.token, 'codex.commandExecution', { command: 'id' }, 'command');
    assert.equal(store.finishRun(w.id, w.token, 'cancelled', null, 'cancelled'), true);
    assert.throws(() => store.expirePermission(late.id, w.token), code('lease_lost'));
    assert.equal(store.expirePermission(late.id).decision, 'expired');
    assert.equal(store.getRun(w.id).status, 'cancelled');
  } finally { store.close(); }
});
