import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, type CreateRunInput } from '../src/store.js';
import { BridgeError, type Conversation } from '../src/types.js';
import { processIdentity, workerAlive } from '../src/process-identity.js';

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function stateDir() {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-store-'));
  roots.push(root);
  return join(root, 'state');
}

class Clock { t = 1_000; now = () => this.t; }

const conversation = (id: string = randomUUID()): Conversation => ({
  id, runtime: 'claude', nativeId: null, cwd: '/work', sourceCwd: '/src', mode: 'review', model: 'claude-opus-5-5', effort: 'high',
  baseCommit: null, branch: null, sessionInitialized: false, createdAt: 1_000,
});

let counter = 0;
function request(c: Conversation, extra: Partial<CreateRunInput> = {}): CreateRunInput {
  counter++;
  return {
    conversation: c, requestKey: `key-${counter}`, fingerprint: `fp-${counter}`, prompt: `prompt ${counter}`,
    model: 'claude-opus-5-5', effort: 'high', timeoutMs: 60_000, maxTurns: 8, ...extra,
  };
}

function queue(store: Store, c: Conversation, extra: Partial<CreateRunInput> = {}) {
  const { run } = store.createRun(request(c, extra));
  const token = randomUUID();
  assert.equal(store.attachWorker(run.id, token, process.pid), true);
  return { id: run.id, token };
}

const code = (expected: string) => (error: unknown) => error instanceof BridgeError && error.code === expected;

test('FIFO follows insertion order even when the wall clock moves backwards', () => {
  const clock = new Clock(), store = new Store(stateDir(), clock.now), c = conversation();
  try {
    const first = queue(store, c);
    clock.t -= 500;
    const second = queue(store, c);
    assert.equal(store.claimRun(second.id, second.token, 2), false);
    assert.equal(store.claimRun(first.id, first.token, 2), true);
  } finally { store.close(); }
});

test('default and explicit unlimited admit independent workers but still serialize each conversation', async () => {
  const dir = stateDir(), store = new Store(dir);
  try {
    const c = conversation();
    const first = queue(store, c), second = queue(store, c);
    const jobs = [first, ...Array.from({ length: 5 }, () => queue(store, conversation()))];
    const claims = await Promise.all(jobs.map((job, index) => child(dir,
      index % 2 ? `out = store.claimRun(args[0], args[1], 'unlimited')` : 'out = store.claimRun(args[0], args[1])', job.id, job.token)));
    assert.deepEqual(claims, [true, true, true, true, true, true]);
    assert.equal(store.claimRun(second.id, second.token), false);
    store.finishRun(first.id, first.token, 'succeeded');
    assert.equal(store.claimRun(second.id, second.token), true);
    const extra = queue(store, conversation());
    assert.equal(store.claimRun(extra.id, extra.token, 6), false);
    store.finishRun(second.id, second.token, 'succeeded');
    assert.equal(store.claimRun(extra.id, extra.token, 6), true);
  } finally { store.close(); }
});

test('cancellation and expiry invalidate even previously answered commands', () => {
  const clock = new Clock(), store = new Store(stateDir(), clock.now);
  try {
    const w = queue(store, conversation()); store.claimRun(w.id, w.token);
    const p = store.requestPermission(w.id, w.token, 'Bash', { command: 'fixture' }, 'fixture', 1000);
    store.answerPermission(p.id, 'allow');
    store.requestCancel(w.id);
    assert.equal(store.consumePermission(p.id, w.token)?.decision, 'expired');
    store.finishRun(w.id, w.token, 'cancelled');
    const x = queue(store, conversation()); store.claimRun(x.id, x.token);
    const pending = store.requestPermission(x.id, x.token, 'Bash', { command: 'fixture' }, 'fixture', 1000);
    store.requestCancel(x.id);
    assert.throws(() => store.answerPermission(pending.id, 'allow'), code('permission_closed'));
  } finally { store.close(); }
});

test('pruning removes task content while retaining duplicate-submission receipts', () => {
  const clock = new Clock(), store = new Store(stateDir(), clock.now);
  try {
    const input = request(conversation()); const { run } = store.createRun(input);
    const token = randomUUID(); store.attachWorker(run.id, token, 1); store.claimRun(run.id, token);
    store.appendEvent(run.id, 'text', 'private text'); store.finishRun(run.id, token, 'succeeded', 'private result');
    clock.t += 1000;
    assert.equal(store.prune(clock.t), 1);
    assert.equal(store.getRun(run.id).prompt, '[pruned]');
    assert.equal(store.getRun(run.id).result, null);
    assert.equal(store.events(run.id).length, 0);
    assert.equal(store.createRun(input).created, false);
  } finally { store.close(); }
});

// Runs a snippet against the store in a separate Node process so SQLite locking is exercised for real.
const root = fileURLToPath(new URL('..', import.meta.url));
const storeUrl = new URL('../src/store.ts', import.meta.url).href;
function child(dir: string, body: string, ...args: string[]): Promise<unknown> {
  const script = `const { Store } = await import(${JSON.stringify(storeUrl)});
const [dir, ...args] = process.argv.slice(1);
const store = new Store(dir);
let out;
try { ${body} } finally { store.close(); }
process.stdout.write(JSON.stringify(out));`;
  return new Promise((resolve, reject) => execFile(
    process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir, ...args], { cwd: root },
    (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout)),
  ));
}

test('idempotency keys are global across connections and conversations are preserved', () => {
  const dir = stateDir();
  const a = new Store(dir), b = new Store(dir);
  try {
    const input = request(conversation());
    const first = a.createRun(input);
    assert.deepEqual([first.created, first.run.status, first.run.workerToken], [true, 'queued', null]);
    const again = b.createRun(input);
    assert.deepEqual([again.created, again.run.id], [false, first.run.id]);
    assert.throws(() => b.createRun({ ...input, fingerprint: 'other' }), code('idempotency_conflict'));
    assert.throws(() => a.createRun({ ...input, conversation: conversation(), fingerprint: 'other' }), code('idempotency_conflict'));
    assert.equal(b.findByRequestKey(input.requestKey)?.id, first.run.id);
    assert.equal(b.findByRequestKey('missing'), null);

    const followUp = b.createRun(request({ ...input.conversation, cwd: '/elsewhere', mode: 'write' }));
    assert.deepEqual([followUp.created, followUp.conversation.cwd, followUp.conversation.mode], [true, '/work', 'review']);
    assert.equal(a.listRuns().length, 2);
    assert.equal(a.listConversations().length, 1);
  } finally { a.close(); b.close(); }
});

test('concurrent processes agree on idempotent run creation', async () => {
  const dir = stateDir();
  new Store(dir).close();
  const keys = 15;
  const body = `out = [];
for (let i = 0; i < ${keys}; i++) {
  try {
    const r = store.createRun({ conversation: { ...JSON.parse(args[1]), id: 'conv-' + i }, requestKey: 'race-' + i, fingerprint: args[0],
      prompt: 'p', model: 'm', effort: 'high', timeoutMs: 1000, maxTurns: 1 });
    out.push({ id: r.run.id, created: r.created });
  } catch (e) { if (e.code !== 'idempotency_conflict') throw e; out.push({ conflict: true }); }
}`;
  const fingerprints = ['a', 'a', 'a', 'b', 'b', 'b'];
  const results = await Promise.all(fingerprints.map(fp => child(dir, body, fp, JSON.stringify(conversation('ignored'))))) as
    Array<Array<{ id?: string; created?: boolean; conflict?: boolean }>>;
  const store = new Store(dir);
  try {
    for (let i = 0; i < keys; i++) {
      const winner = store.findByRequestKey(`race-${i}`)!;
      const outcomes = results.map(r => r[i]!);
      assert.equal(outcomes.filter(o => o.created).length, 1);
      outcomes.forEach((o, j) => {
        if (fingerprints[j] === winner.fingerprint) assert.equal(o.id, winner.id);
        else assert.equal(o.conflict, true);
      });
    }
    assert.equal(store.listRuns(100).length, keys);
  } finally { store.close(); }
});

test('one active turn per conversation in deterministic order', () => {
  const clock = new Clock();
  const store = new Store(stateDir(), clock.now);
  try {
    const c = conversation();
    const first = queue(store, c), second = queue(store, c);
    assert.equal(store.claimRun(second.id, second.token), false);
    assert.equal(store.claimRun(first.id, 'wrong-token'), false);
    assert.equal(store.claimRun(first.id, first.token), true);
    assert.equal(store.claimRun(first.id, first.token), false);
    assert.equal(store.claimRun(second.id, second.token, 10), false);
    assert.deepEqual(store.listRuns().map(r => r.id), [second.id, first.id]);
    assert.equal(store.finishRun(first.id, first.token, 'succeeded', 'done'), true);
    clock.t += 10;
    assert.equal(store.claimRun(second.id, second.token), true);
    const run = store.getRun(second.id);
    assert.deepEqual([run.status, run.startedAt, run.heartbeatAt], ['running', 1_010, 1_010]);

    const third = queue(store, conversation());
    const cancelled = store.requestCancel(third.id);
    assert.deepEqual([cancelled.status, cancelled.cancelRequested], ['queued', true]);
    assert.equal(store.claimRun(third.id, third.token, 10), false);
    assert.equal(store.getRun(third.id).status, 'queued');
  } finally { store.close(); }
});

test('global active limit counts running and needs_input runs', () => {
  const store = new Store(stateDir());
  try {
    const a = queue(store, conversation()), b = queue(store, conversation()), c = queue(store, conversation());
    assert.equal(store.claimRun(a.id, a.token, 2), true);
    assert.equal(store.claimRun(b.id, b.token, 2), true);
    store.requestPermission(b.id, b.token, 'Bash', { command: 'ls' }, 'list files');
    assert.equal(store.getRun(b.id).status, 'needs_input');
    assert.equal(store.claimRun(c.id, c.token, 2), false);
    assert.equal(store.finishRun(a.id, a.token, 'failed', null, 'boom'), true);
    assert.equal(store.claimRun(c.id, c.token, 2), true);
  } finally { store.close(); }
});

test('concurrent claims from separate processes respect the global limit', async () => {
  const dir = stateDir();
  const store = new Store(dir);
  try {
    const runs = Array.from({ length: 6 }, () => queue(store, conversation()));
    const claimed = await Promise.all(runs.map(r => child(dir, 'out = store.claimRun(args[0], args[1], 2);', r.id, r.token)));
    assert.equal(claimed.filter(Boolean).length, 2);
    assert.equal(store.listRuns().filter(r => r.status === 'running').length, 2);
  } finally { store.close(); }
});

test('stale workers are fenced by reconcile and tokens are never stolen', () => {
  const clock = new Clock();
  const store = new Store(stateDir(), clock.now);
  try {
    const live = queue(store, conversation()), lost = queue(store, conversation());
    const { run: orphan } = store.createRun(request(conversation()));
    assert.equal(store.claimRun(lost.id, lost.token, 5), true);
    assert.equal(store.claimRun(live.id, live.token, 5), true);
    const permission = store.requestPermission(lost.id, lost.token, 'Write', { path: 'x' }, 'edit');
    clock.t = 5_000;
    assert.equal(store.heartbeat(live.id, live.token), true);
    assert.equal(store.heartbeat(live.id, lost.token), false);
    assert.equal(store.reconcile(4_000), 2);

    const fenced = store.getRun(lost.id);
    assert.deepEqual([fenced.status, fenced.errorCode, fenced.finishedAt], ['unknown', 'worker_lost', 5_000]);
    assert.equal(store.getRun(orphan.id).status, 'failed');
    assert.equal(store.getRun(orphan.id).errorCode, 'worker_start_lost');
    assert.equal(store.getRun(live.id).status, 'running');
    assert.equal(store.getPermission(permission.id).decision, 'expired');
    assert.equal(store.heartbeat(lost.id, lost.token), false);
    assert.equal(store.finishRun(lost.id, lost.token, 'succeeded', 'late result'), false);
    assert.throws(() => store.requestPermission(lost.id, lost.token, 'Bash', {}, 'x'), code('lease_lost'));
    assert.throws(() => store.consumePermission(permission.id, lost.token), code('lease_lost'));
    assert.throws(() => store.answerPermission(permission.id, 'allow'), code('permission_closed'));
    assert.equal(store.attachWorker(orphan.id, 'late', 1), false);
    assert.equal(store.finishRun(orphan.id, null, 'failed'), false);
    assert.equal(store.reconcile(4_000), 0);

    const { run: unowned } = store.createRun(request(conversation()));
    assert.equal(store.finishRun(unowned.id, null, 'failed', null, 'spawn_failed'), true);
    assert.equal(store.getRun(unowned.id).errorCode, 'spawn_failed');
    const owned = queue(store, conversation());
    assert.equal(store.attachWorker(owned.id, 'thief', 2), false);
    assert.equal(store.finishRun(owned.id, null, 'failed'), false);
    assert.equal(store.finishRun(owned.id, 'thief', 'failed'), false);
    assert.equal(store.getRun(owned.id).status, 'queued');
  } finally { store.close(); }
});

test('unknown outcomes gate follow-up turns until acknowledged', () => {
  const clock = new Clock();
  const store = new Store(stateDir(), clock.now);
  try {
    const c = conversation();
    const lost = queue(store, c);
    assert.equal(store.claimRun(lost.id, lost.token), true);
    const behind = queue(store, c);
    clock.t = 10_000;
    assert.equal(store.heartbeat(behind.id, behind.token), true);
    assert.equal(store.reconcile(5_000), 1);

    assert.equal(store.claimRun(behind.id, behind.token), false);
    assert.deepEqual([store.getRun(behind.id).status, store.getRun(behind.id).errorCode], ['failed', 'blocked_by_unknown']);
    assert.throws(() => store.createRun(request(c)), code('blocked_by_unknown'));

    const acknowledged = queue(store, c, { acknowledgeUncertain: true });
    assert.equal(store.claimRun(acknowledged.id, acknowledged.token), true);
    assert.equal(store.finishRun(acknowledged.id, acknowledged.token, 'succeeded', 'ok'), true);
    const next = queue(store, c);
    assert.equal(store.claimRun(next.id, next.token), true);
    assert.equal(store.finishRun(next.id, next.token, 'succeeded', 'ok'), true);

    // Acknowledgement only covers outcomes that were already unknown when the request was made.
    const c2 = conversation();
    const first = queue(store, c2);
    assert.equal(store.claimRun(first.id, first.token), true);
    const eager = queue(store, c2, { acknowledgeUncertain: true });
    clock.t = 20_000;
    assert.equal(store.heartbeat(eager.id, eager.token), true);
    assert.equal(store.reconcile(15_000), 1);
    assert.equal(store.claimRun(eager.id, eager.token), false);
    assert.equal(store.getRun(eager.id).errorCode, 'blocked_by_unknown');
  } finally { store.close(); }
});

test('results, events and session state survive reopen with private files', () => {
  const dir = stateDir();
  let store = new Store(dir);
  const c = conversation(), c2 = conversation();
  const run = queue(store, c);
  assert.equal(store.claimRun(run.id, run.token), true);
  store.markSessionInitialized(c.id);
  const e1 = store.appendEvent(run.id, 'text', { chunk: 'hello' });
  const e2 = store.appendEvent(run.id, 'tool', { name: 'Read' });
  const other = queue(store, c2);
  const e3 = store.appendEvent(other.id, 'text', null);
  assert.ok(e1.seq < e2.seq && e2.seq < e3.seq);
  assert.throws(() => store.appendEvent('missing', 'text', {}), code('not_found'));
  assert.throws(() => store.markSessionInitialized('missing'), code('not_found'));
  assert.equal(store.finishRun(run.id, run.token, 'succeeded', 'final answer'), true);
  store.close();

  if (process.platform !== 'win32') {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'bridge.sqlite')).mode & 0o777, 0o600);
  }
  store = new Store(dir);
  try {
    const saved = store.getRun(run.id);
    assert.deepEqual([saved.status, saved.result, saved.workerToken], ['succeeded', 'final answer', run.token]);
    assert.equal(store.getConversation(c.id).sessionInitialized, true);
    assert.deepEqual(store.events(run.id).map(e => [e.seq, e.type, e.data]), [[e1.seq, 'text', { chunk: 'hello' }], [e2.seq, 'tool', { name: 'Read' }]]);
    assert.deepEqual(store.events(run.id, e1.seq).map(e => e.seq), [e2.seq]);
    assert.deepEqual(store.events(run.id, 0, 1).map(e => e.seq), [e1.seq]);
    assert.deepEqual(store.listRuns().map(r => r.id), [other.id, run.id]);
    assert.deepEqual(store.listRuns(1).map(r => r.id), [other.id]);
    assert.deepEqual(store.listConversations().map(x => x.id), [c2.id, c.id]);
    assert.throws(() => store.getRun('missing'), code('not_found'));
    assert.throws(() => store.getConversation('missing'), code('not_found'));
    const e4 = store.appendEvent(other.id, 'text', 'after reopen');
    assert.ok(e4.seq > e3.seq);
  } finally { store.close(); }
});

test('permission answers are single-use and fenced by expiry and termination', () => {
  const clock = new Clock();
  const store = new Store(stateDir(), clock.now);
  try {
    const w = queue(store, conversation());
    assert.equal(store.claimRun(w.id, w.token), true);
    const p = store.requestPermission(w.id, w.token, 'Bash', { command: 'rm -rf build' }, 'clean', 1_000);
    assert.deepEqual([p.decision, p.expiresAt, p.input], ['pending', 2_000, { command: 'rm -rf build' }]);
    assert.throws(() => store.requestPermission(w.id, w.token, 'Bash', {}, 'again'), code('permission_pending'));
    assert.throws(() => store.requestPermission(w.id, 'intruder', 'Bash', {}, 'x'), code('lease_lost'));
    assert.deepEqual(store.pendingPermissions(w.id).map(x => x.id), [p.id]);
    assert.equal(store.consumePermission(p.id, w.token), null);
    assert.throws(() => store.consumePermission(p.id, 'intruder'), code('lease_lost'));
    assert.throws(() => store.answerPermission(p.id, 'allow', { choice: 'yes' }), code('invalid_argument'));
    const answered = store.answerPermission(p.id, 'allow');
    assert.deepEqual([answered.decision, answered.answers], ['allow', null]);
    assert.throws(() => store.answerPermission(p.id, 'deny'), code('permission_closed'));
    assert.equal(store.getRun(w.id).status, 'needs_input');
    assert.equal(store.consumePermission(p.id, w.token)?.decision, 'allow');
    assert.equal(store.getRun(w.id).status, 'running');
    assert.throws(() => store.consumePermission(p.id, w.token), code('permission_consumed'));

    const late = store.requestPermission(w.id, w.token, 'Write', { path: 'a' }, 'write', 1_000);
    clock.t += 1_000;
    assert.throws(() => store.answerPermission(late.id, 'allow'), code('permission_expired'));
    assert.equal(store.getPermission(late.id).decision, 'expired');
    assert.equal(store.consumePermission(late.id, w.token)?.decision, 'expired');
    assert.equal(store.getRun(w.id).status, 'running');

    const open = store.requestPermission(w.id, w.token, 'Bash', {}, 'more');
    const cancelling = store.requestCancel(w.id);
    assert.deepEqual([cancelling.status, cancelling.cancelRequested], ['needs_input', true]);
    assert.equal(store.finishRun(w.id, w.token, 'cancelled'), true);
    assert.equal(store.getPermission(open.id).decision, 'expired');
    assert.throws(() => store.answerPermission(open.id, 'allow'), code('permission_closed'));
    assert.throws(() => store.consumePermission(open.id, w.token), code('lease_lost'));
    assert.deepEqual(store.pendingPermissions(w.id), []);
  } finally { store.close(); }
});

test('terminal runs cannot be rewritten', () => {
  const clock = new Clock();
  const store = new Store(stateDir(), clock.now);
  try {
    const w = queue(store, conversation());
    assert.equal(store.claimRun(w.id, w.token), true);
    assert.equal(store.finishRun(w.id, w.token, 'succeeded', 'first'), true);
    const done = store.getRun(w.id);
    clock.t += 60_000;
    assert.equal(store.finishRun(w.id, w.token, 'failed', 'second', 'late'), false);
    assert.equal(store.finishRun(w.id, null, 'cancelled'), false);
    assert.equal(store.heartbeat(w.id, w.token), false);
    assert.equal(store.claimRun(w.id, w.token), false);
    assert.equal(store.attachWorker(w.id, 'new', 1), false);
    assert.equal(store.reconcile(clock.t + 1), 0);
    assert.deepEqual(store.requestCancel(w.id), done);
    assert.throws(() => store.requestPermission(w.id, w.token, 'Bash', {}, 'x'), code('lease_lost'));
    assert.throws(() => store.finishRun(w.id, w.token, 'running' as never), code('invalid_argument'));
    assert.deepEqual(store.getRun(w.id), done);
  } finally { store.close(); }
});


test('questions require answers for the exact requested questions', () => {
  const store = new Store(stateDir());
  try {
    const w = queue(store, conversation()); store.claimRun(w.id, w.token);
    const p = store.requestPermission(w.id, w.token, 'AskUserQuestion', { questions: [{ question: 'Which colour?' }] }, 'question');
    assert.throws(() => store.answerPermission(p.id, 'allow'), code('answers_required'));
    assert.throws(() => store.answerPermission(p.id, 'allow', { wrong: 'blue' }), code('answers_required'));
    store.answerPermission(p.id, 'allow', { 'Which colour?': 'blue' });
    assert.deepEqual(store.consumePermission(p.id, w.token)?.answers, { 'Which colour?': 'blue' });
  } finally { store.close(); }
});

test('sleep-aged leases retain the exact living process, but a reused PID cannot retain ownership', () => {
  const clock = new Clock(), store = new Store(stateDir(), clock.now);
  try {
    const identity = processIdentity(process.pid);
    assert.ok(identity, 'current process must have a platform start identity');
    assert.equal(processIdentity(-1), null);
    const run = store.createRun(request(conversation())).run;
    store.attachWorker(run.id, 'owner', process.pid, identity);
    store.claimRun(run.id, 'owner');
    clock.t += 600_000;
    assert.equal(store.reconcile(clock.t - 120_000, workerAlive), 0);
    assert.equal(store.reconcile(clock.t - 120_000, () => undefined), 0, 'inconclusive liveness probe must not fence');
    assert.equal(store.getRun(run.id).status, 'running');
    assert.equal(workerAlive({ ...store.getRun(run.id), workerIdentity: `${identity}:different-start` }), false);
    // A heartbeat between liveness probing and the SQL update must win the race.
    assert.equal(store.reconcile(clock.t - 120_000, () => { store.heartbeat(run.id, 'owner'); return false; }), 0);
    clock.t += 600_000;
    assert.equal(store.reconcile(clock.t - 120_000, () => false), 1);
    assert.equal(store.getRun(run.id).status, 'unknown');
  } finally { store.close(); }
});

test('a lost launch fails safely without replay; a fresh request can use the unstarted conversation', () => {
  const clock = new Clock(), store = new Store(stateDir(), clock.now);
  try {
    const c = conversation(), input = request(c), run = store.createRun(input).run;
    clock.t += 600_000;
    assert.equal(store.reconcile(clock.t - 120_000, workerAlive), 1);
    assert.equal(store.createRun(input).run.status, 'failed');
    assert.equal(store.createRun(input).created, false);
    const next = queue(store, c);
    assert.equal(store.claimRun(next.id, next.token), true);
    const orphan = store.createRun(request(conversation())).run;
    assert.equal(store.requestCancel(orphan.id).status, 'cancelled');
    assert.equal(store.attachWorker(orphan.id, 'late', process.pid), false);
  } finally { store.close(); }
});
