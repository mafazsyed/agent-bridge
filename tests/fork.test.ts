import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { Bridge } from '../src/service.js';
import { Store } from '../src/store.js';
import { prepareWorktree, snapshotFork } from '../src/git.js';
import { runClaude } from '../src/runtime.js';
import { runCodex } from '../src/codex-runtime.js';
import { CodexClient } from '../src/codex-client.js';
import { BridgeError, type Runtime } from '../src/types.js';
import { z } from 'zod';

function setup(runtime: Runtime = 'claude') {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-fork-')));
  const settings = { stateDir: join(root, 'state'), executable: 'fixture', codexExecutable: 'fixture', maxActive: 'unlimited' as const, staleMs: 120_000 };
  let launches = 0;
  const bridge = new Bridge(settings, () => { launches++; });
  const first = bridge.start({ requestKey: 'source', prompt: 'Remember a marker', cwd: root, runtime, model: runtime === 'codex' ? 'native-model' : 'sonnet', effort: 'low' });
  bridge.store.attachWorker(first.run.id, 'source-token', process.pid);
  bridge.store.claimRun(first.run.id, 'source-token', 'unlimited');
  if (runtime === 'codex') bridge.store.bindNativeSession(first.run.id, 'source-token', 'native-thread', 'native-model', 'low');
  else bridge.store.markSessionInitialized(first.conversation.id);
  bridge.store.appendEvent(first.run.id, 'result', { turnId: 'source-turn' });
  bridge.store.finishRun(first.run.id, 'source-token', 'succeeded', 'marker');
  const request = { sourceConversationId: first.conversation.id, requestKey: 'fork', prompt: 'Try another approach' };
  const claim = (id: string) => { bridge.store.attachWorker(id, 'child-token', process.pid); assert.equal(bridge.store.claimRun(id, 'child-token', 'unlimited'), true); return bridge.store.getRun(id); };
  return { root, settings, bridge, first, request, claim, launches: () => launches,
    clean() { bridge.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}

test('fork submission is idempotent, keeps defaults/lineage, and fences source only until native copy binds', () => {
  const f = setup();
  try {
    const child = f.bridge.fork({ ...f.request, model: 'haiku', effort: 'medium', permissions: { runtime: 'claude', permissionMode: 'plan' } });
    assert.equal(f.bridge.fork({ ...f.request, model: 'haiku', effort: 'medium', permissions: { runtime: 'claude', permissionMode: 'plan' } }).run.id, child.run.id);
    assert.equal(f.launches(), 2);
    assert.equal(child.conversation.model, 'haiku');
    assert.equal(f.bridge.store.getConversation(f.first.conversation.id).model, 'sonnet');
    assert.equal(child.conversation.fork?.runId, f.first.run.id);
    assert.throws(() => f.bridge.start({ conversationId: f.first.conversation.id, requestKey: 'next', prompt: 'Continue' }), { code: 'fork_in_progress' });
    assert.throws(() => f.bridge.start({ conversationId: child.conversation.id, requestKey: 'too-soon', prompt: 'Continue' }), { code: 'fork_not_ready' });
    assert.throws(() => f.bridge.fork({ ...f.request, prompt: 'Different' }), { code: 'idempotency_conflict' });
    assert.throws(() => f.bridge.fork({ ...f.request, requestKey: 'source' }), { code: 'idempotency_conflict' });
    f.claim(child.run.id);
    assert.throws(() => f.bridge.store.markSessionInitialized(child.conversation.id, child.run.id, 'wrong'), { code: 'lease_lost' });
    f.bridge.store.markSessionInitialized(child.conversation.id, child.run.id, 'child-token');
    const parentNext = f.bridge.start({ conversationId: f.first.conversation.id, requestKey: 'next', prompt: 'Continue' });
    f.bridge.store.attachWorker(parentNext.run.id, 'parent-next', process.pid);
    assert.equal(f.bridge.store.claimRun(parentNext.run.id, 'parent-next', 'unlimited'), true, 'Parent and fork may run independently after copy');
    const childNext = f.bridge.start({ conversationId: child.conversation.id, requestKey: 'child-next', prompt: 'Continue' });
    f.bridge.store.attachWorker(childNext.run.id, 'later', process.pid);
    assert.equal(f.bridge.store.claimRun(childNext.run.id, 'later', 'unlimited'), false, 'Child turns still serialize');
    assert.deepEqual(childNext.run.permissions, child.conversation.permissions);
    f.bridge.store.finishRun(child.run.id, 'child-token', 'succeeded', 'fork reply');
    f.bridge.store.prune(Date.now() + 1);
    const reopened = new Store(f.settings.stateDir);
    assert.deepEqual(reopened.getConversation(child.conversation.id).fork, child.conversation.fork);
    reopened.close();
  } finally { f.clean(); }
});

test('multiple forks share a read source; cancellation and stale reconciliation release reservations', () => {
  const f = setup();
  try {
    const a = f.bridge.fork(f.request);
    const b = f.bridge.fork({ ...f.request, requestKey: 'another' });
    f.bridge.store.requestCancel(a.run.id);
    assert.throws(() => f.bridge.start({ conversationId: f.first.conversation.id, requestKey: 'next', prompt: 'Continue' }), { code: 'fork_in_progress' });
    f.bridge.store.reconcile(Date.now() + 1, () => false);
    assert.equal(f.bridge.get(b.run.id).run.status, 'failed');
    assert.throws(() => f.bridge.start({ conversationId: a.conversation.id, requestKey: 'retry-child', prompt: 'Continue', acknowledgeUncertain: true }), { code: 'fork_not_ready' });
    f.bridge.start({ conversationId: f.first.conversation.id, requestKey: 'next', prompt: 'Continue' });
    assert.throws(() => f.bridge.fork({ ...f.request, requestKey: 'busy' }), { code: 'fork_source_busy' });
  } finally { f.clean(); }
});

test('fork checkpoint is checked in the insert transaction and failed/unknown source cannot be bypassed', () => {
  const f = setup();
  try {
    const original = f.bridge.store.createRun.bind(f.bridge.store);
    f.bridge.store.createRun = input => {
      f.bridge.store.createRun = original;
      f.bridge.start({ conversationId: f.first.conversation.id, requestKey: 'race', prompt: 'Advance source' });
      return original(input);
    };
    assert.throws(() => f.bridge.fork(f.request), { code: 'fork_source_busy' });
    const raced = f.bridge.store.findByRequestKey('race')!;
    f.bridge.store.finishRun(raced.id, null, 'unknown');
    assert.throws(() => f.bridge.fork(f.request), { code: 'fork_source_not_ready' });
    assert.equal(f.bridge.store.findByRequestKey('fork'), null);
    assert.throws(() => f.bridge.fork({ ...f.request, runtime: 'codex' } as any), z.ZodError);
    assert.throws(() => f.bridge.fork({ ...f.request, cwd: f.root } as any), z.ZodError);
  } finally { f.clean(); }
});

test('failed fork worker launch releases the source reservation', () => {
  const f = setup(), b = new Bridge(f.settings, () => { throw new Error('Fixture launch failure'); });
  try {
    assert.throws(() => b.fork(f.request), /Fixture launch failure/);
    assert.equal(f.bridge.store.findByRequestKey('fork')?.errorCode, 'worker_start_failed');
    f.bridge.start({ conversationId: f.first.conversation.id, requestKey: 'after-launch-failure', prompt: 'Continue' });
  } finally { b.close(); f.clean(); }
});

test('fork inherits saved permission default, not latest run override; null resets explicitly', () => {
  const f = setup();
  try {
    const planned = f.bridge.start({ requestKey: 'plan', prompt: 'plan', cwd: f.root, permissions: { runtime: 'claude', permissionMode: 'plan' } });
    f.bridge.store.attachWorker(planned.run.id, 'p', process.pid); f.bridge.store.claimRun(planned.run.id, 'p');
    f.bridge.store.markSessionInitialized(planned.conversation.id); f.bridge.store.finishRun(planned.run.id, 'p', 'succeeded');
    const overridden = f.bridge.start({ conversationId: planned.conversation.id, requestKey: 'override', prompt: 'read', permissions: null });
    f.bridge.store.attachWorker(overridden.run.id, 'o', process.pid); f.bridge.store.claimRun(overridden.run.id, 'o'); f.bridge.store.finishRun(overridden.run.id, 'o', 'succeeded');
    const child = f.bridge.fork({ ...f.request, sourceConversationId: planned.conversation.id });
    assert.deepEqual(child.run.permissions, { runtime: 'claude', permissionMode: 'plan' });
    assert.equal(f.bridge.fork({ ...f.request, requestKey: 'reset', sourceConversationId: planned.conversation.id, permissions: null }).run.permissions, null);
    assert.throws(() => f.bridge.fork({ ...f.request, requestKey: 'escalate', permissions: { runtime: 'claude', permissionMode: 'bypassPermissions' } }), { code: 'invalid_permissions' });
    const saved = process.env.AGENT_BRIDGE_DELEGATION_DEPTH;
    try { process.env.AGENT_BRIDGE_DELEGATION_DEPTH = '1'; assert.throws(() => f.bridge.fork(f.request), { code: 'delegation_loop' }); }
    finally { if (saved === undefined) delete process.env.AGENT_BRIDGE_DELEGATION_DEPTH; else process.env.AGENT_BRIDGE_DELEGATION_DEPTH = saved; }
  } finally { f.clean(); }
});

test('v4 migration preserves original submission receipts and adds null lineage', () => {
  const f = setup(); f.bridge.close();
  const db = new DatabaseSync(join(f.settings.stateDir, 'bridge.sqlite'));
  db.exec('DROP INDEX conversations_fork_source; ALTER TABLE conversations DROP COLUMN fork_json; PRAGMA user_version=4'); db.close();
  const b = new Bridge(f.settings, () => { throw new Error('duplicate launch'); });
  try {
    const old = b.start({ requestKey: 'source', prompt: 'Remember a marker', cwd: f.root, runtime: 'claude', model: 'sonnet', effort: 'low' });
    assert.equal(old.created, false); assert.equal(old.conversation.fork, null);
  } finally { b.close(); rmSync(f.root, { recursive: true, force: true }); }
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
async function writeSource(f: ReturnType<typeof setup>) {
  git(f.root, 'init', '-q');
  writeFileSync(join(f.root, '.gitignore'), 'state/\n'); writeFileSync(join(f.root, 'seed'), 'base\n');
  git(f.root, 'add', '.'); git(f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
  const parent = f.bridge.start({ requestKey: 'write-source', prompt: 'edit', cwd: f.root, mode: 'write', baseRef: 'HEAD' });
  await prepareWorktree(parent.conversation);
  f.bridge.store.attachWorker(parent.run.id, 'p', process.pid); f.bridge.store.claimRun(parent.run.id, 'p');
  f.bridge.store.markSessionInitialized(parent.conversation.id); f.bridge.store.finishRun(parent.run.id, 'p', 'succeeded');
  return parent;
}

test('fork scans listings larger than one megabyte without buffering the repository', async () => {
  const f = setup();
  try {
    const parent = await writeSource(f);
    git(parent.conversation.cwd, 'config', 'core.autocrlf', 'true');
    git(parent.conversation.cwd, 'config', 'core.safecrlf', 'warn');
    // Both the staged-file scan and changed-name scan exceed the old 1 MiB cap.
    // Line-ending warnings from add exceed it too; preserve Git's configured conversion.
    const prefix = 'long-path-'.repeat(13);
    for (let i = 0; i < 8100; i++) writeFileSync(join(parent.conversation.cwd, `${prefix}${i}.txt`), 'line\n');
    const child = f.bridge.fork({ ...f.request, sourceConversationId: parent.conversation.id }); f.claim(child.run.id);
    assert.match(await snapshotFork(child.conversation), /^[a-f0-9]{40,64}$/);
    assert.equal(git(parent.conversation.cwd, 'diff', '--cached', '--name-only'), '');
  } finally { f.clean(); }
});

test('committed agent configuration is checked against the original source base', async () => {
  const f = setup();
  try {
    const parent = await writeSource(f);
    mkdirSync(join(parent.conversation.cwd, '.codex'));
    writeFileSync(join(parent.conversation.cwd, '.codex', 'config.toml'), 'fixture=true');
    git(parent.conversation.cwd, 'add', '.codex');
    git(parent.conversation.cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'changed config');
    const child = f.bridge.fork({ ...f.request, sourceConversationId: parent.conversation.id }); f.claim(child.run.id);
    assert.notEqual(child.conversation.baseCommit, child.conversation.fork?.sourceBaseCommit);
    await assert.rejects(() => snapshotFork(child.conversation), { code: 'fork_source_agent_config_changed' });
  } finally { f.clean(); }
});

for (const embedded of [false, true]) test(`fork refuses ${embedded ? 'embedded repositories' : 'submodules'} and cleans its temporary index`, async () => {
  const f = setup();
  try {
    const parent = await writeSource(f);
    if (embedded) {
      const nested = join(parent.conversation.cwd, 'nested'); mkdirSync(nested);
      git(nested, 'init', '-q'); writeFileSync(join(nested, 'file'), 'nested\n'); git(nested, 'add', '.');
      git(nested, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'nested');
    } else {
      git(parent.conversation.cwd, 'update-index', '--add', '--cacheinfo', `160000,${parent.conversation.baseCommit},nested`);
      git(parent.conversation.cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'submodule');
      mkdirSync(join(parent.conversation.cwd, 'nested'));
    }
    const child = f.bridge.fork({ ...f.request, sourceConversationId: parent.conversation.id }); f.claim(child.run.id);
    await assert.rejects(() => snapshotFork(child.conversation), { code: 'fork_submodules_unsupported' });
    assert.equal(readdirSync(join(f.settings.stateDir, 'worktrees')).some(p => p.startsWith('.fork-index-')), false);
  } finally { f.clean(); }
});

test('write fork snapshots staged, unstaged, deleted and untracked files without changing the parent index or HEAD', async () => {
  const f = setup();
  try {
    git(f.root, 'init', '-q');
    for (const [p, text] of Object.entries({ '.gitignore': 'ignored/\nstate/\n', 'file.txt': 'base\n', 'deleted.txt': 'delete\n' })) writeFileSync(join(f.root, p), text);
    git(f.root, 'add', '.'); git(f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
    git(f.root, 'config', 'commit.gpgSign', 'true');
    const parent = f.bridge.start({ requestKey: 'write', prompt: 'edit', cwd: f.root, mode: 'write', baseRef: 'HEAD' });
    await prepareWorktree(parent.conversation);
    writeFileSync(join(parent.conversation.cwd, 'file.txt'), 'staged\n'); git(parent.conversation.cwd, 'add', 'file.txt');
    writeFileSync(join(parent.conversation.cwd, 'file.txt'), 'unstaged\n');
    writeFileSync(join(parent.conversation.cwd, 'new.txt'), 'untracked\n');
    rmSync(join(parent.conversation.cwd, 'deleted.txt'));
    mkdirSync(join(parent.conversation.cwd, 'ignored')); writeFileSync(join(parent.conversation.cwd, 'ignored', 'secret'), 'not copied');
    if (process.platform !== 'win32') { symlinkSync('file.txt', join(parent.conversation.cwd, 'link')); chmodSync(join(parent.conversation.cwd, 'file.txt'), 0o755); }
    f.bridge.store.attachWorker(parent.run.id, 'p', process.pid); f.bridge.store.claimRun(parent.run.id, 'p');
    f.bridge.store.markSessionInitialized(parent.conversation.id); f.bridge.store.finishRun(parent.run.id, 'p', 'succeeded');
    const index = git(parent.conversation.cwd, 'rev-parse', '--git-path', 'index');
    const bytes = readFileSync(index), status = git(parent.conversation.cwd, 'status', '--porcelain'), head = git(parent.conversation.cwd, 'rev-parse', 'HEAD');
    const child = f.bridge.fork({ ...f.request, sourceConversationId: parent.conversation.id }); f.claim(child.run.id);
    assert.equal(child.conversation.sourceCwd, f.root, 'Worktree cleanup retains the original repository path');
    const savedDir = process.env.GIT_DIR; process.env.GIT_DIR = '/deliberately/wrong';
    let tree: string;
    try { tree = await snapshotFork(child.conversation); } finally { if (savedDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedDir; }
    const saved = f.bridge.store.recordForkSnapshot(child.run.id, 'child-token', tree);
    await prepareWorktree(saved);
    assert.deepEqual(readFileSync(index), bytes);
    assert.equal(git(parent.conversation.cwd, 'status', '--porcelain'), status);
    assert.equal(git(parent.conversation.cwd, 'rev-parse', 'HEAD'), head);
    assert.equal(git(saved.cwd, 'rev-parse', 'HEAD'), head);
    assert.equal(readFileSync(join(saved.cwd, 'file.txt'), 'utf8').trim(), 'unstaged');
    assert.equal(readFileSync(join(saved.cwd, 'new.txt'), 'utf8').trim(), 'untracked');
    assert.equal(existsSync(join(saved.cwd, 'deleted.txt')), false); assert.equal(existsSync(join(saved.cwd, 'ignored')), false);
    if (process.platform !== 'win32') assert.ok(statSync(join(saved.cwd, 'file.txt')).mode & 0o111);
    writeFileSync(join(saved.cwd, 'file.txt'), 'child edits');
    await prepareWorktree(saved);
    assert.equal(readFileSync(join(parent.conversation.cwd, 'file.txt'), 'utf8').trim(), 'unstaged');
    assert.equal(readFileSync(join(saved.cwd, 'file.txt'), 'utf8'), 'child edits');
    mkdirSync(join(parent.conversation.cwd, '.codex')); writeFileSync(join(parent.conversation.cwd, '.codex', 'config.toml'), 'unsafe=true');
    await assert.rejects(() => snapshotFork(child.conversation), { code: 'fork_source_agent_config_changed' });
    assert.equal(readdirSync(join(f.settings.stateDir, 'worktrees')).some(p => p.startsWith('.fork-index-')), false);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(() => snapshotFork(child.conversation, aborted.signal), { name: 'AbortError' });
    git(parent.conversation.cwd, 'checkout', '--detach');
    assert.throws(() => f.bridge.fork({ ...f.request, requestKey: 'detached', sourceConversationId: parent.conversation.id }), { code: 'workspace_conflict' });
  } finally { f.clean(); }
});

for (const scenario of ['ok', 'fork-unsupported', 'fork-missing', 'fork-same-id', 'fork-roots', 'pruned']) test(`Codex fork protocol and isolation: ${scenario}`, async () => {
  const f = setup('codex'), record = join(f.root, 'rpc.jsonl');
  const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
  try {
    if (scenario === 'pruned') f.bridge.store.prune(Date.now() + 1);
    const child = f.bridge.fork(f.request), run = f.claim(child.run.id);
    const work = runCodex(f.settings, f.bridge.store, run, child.conversation, 'child-token', new AbortController(),
      () => new CodexClient(process.execPath, f.root, { args: [fixture, scenario, record] }));
    const success = scenario === 'ok' || scenario === 'pruned';
    if (success) assert.equal((await work).success, true);
    else await assert.rejects(work, { code: ({ 'fork-unsupported': 'fork_unsupported', 'fork-missing': 'fork_source_missing', 'fork-same-id': 'fork_identity_invalid', 'fork-roots': 'sandbox_unavailable' } as const)[scenario as 'fork-missing'] });
    const requests = readFileSync(record, 'utf8').trim().split('\n').map(s => JSON.parse(s));
    const request = requests.find(r => r.method === 'thread/fork');
    assert.equal(request.params.threadId, 'native-thread'); assert.equal(request.params.lastTurnId, scenario === 'pruned' ? undefined : 'source-turn');
    assert.deepEqual(request.params.runtimeWorkspaceRoots, [child.conversation.cwd]);
    assert.equal(request.params.deferGoalContinuation, true); assert.equal(request.params.excludeTurns, true);
    assert.equal(requests.some(r => r.method === 'thread/resume' || r.method === 'thread/start'), false);
    assert.equal(requests.some(r => r.method === 'turn/start'), success);
    if (success) {
      assert.equal(requests.find(r => r.method === 'turn/start').params.threadId, 'fork-thread');
      assert.equal((f.bridge.store.events(run.id).find(e => e.type === 'started')?.data as any).forkTurnPinned, scenario !== 'pruned');
      f.bridge.store.finishRun(run.id, 'child-token', 'succeeded');
      // Native workspace roots are reapplied and checked on every child follow-up.
      for (const resumedScenario of ['ok', 'fork-roots', 'goal-active', 'goal-unsupported']) {
        const next = f.bridge.start({ conversationId: child.conversation.id, requestKey: `resume-${resumedScenario}`, prompt: 'Continue' });
        const nextRun = f.claim(next.run.id), nextRecord = join(f.root, `resume-${resumedScenario}.jsonl`);
        const resumed = runCodex(f.settings, f.bridge.store, nextRun, f.bridge.store.getConversation(child.conversation.id), 'child-token', new AbortController(),
          () => new CodexClient(process.execPath, f.root, { args: [fixture, resumedScenario, nextRecord] }));
        if (resumedScenario === 'ok') assert.equal((await resumed).success, true);
        else await assert.rejects(resumed, { code: resumedScenario === 'fork-roots' ? 'sandbox_unavailable' : resumedScenario === 'goal-active' ? 'fork_native_goal_unsupported' : 'fork_unsupported' });
        const messages = readFileSync(nextRecord, 'utf8').trim().split('\n').map(s => JSON.parse(s));
        const resume = messages.find(r => r.method === 'thread/resume');
        if (resumedScenario.startsWith('goal')) assert.equal(resume, undefined);
        else { assert.equal(resume.params.threadId, 'fork-thread'); assert.deepEqual(resume.params.runtimeWorkspaceRoots, [child.conversation.cwd]); }
        assert.equal(messages.some(r => r.method === 'turn/start'), resumedScenario === 'ok');
        f.bridge.store.finishRun(nextRun.id, 'child-token', resumedScenario === 'ok' ? 'succeeded' : 'failed');
      }
    }
  } finally { f.clean(); }
});

for (const scenario of ['goal-active', 'goal-unsupported']) test(`Codex refuses a source with an external or unverifiable goal: ${scenario}`, async () => {
  const f = setup('codex'), record = join(f.root, 'rpc.jsonl');
  const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
  try {
    const child = f.bridge.fork(f.request), run = f.claim(child.run.id);
    await assert.rejects(runCodex(f.settings, f.bridge.store, run, child.conversation, 'child-token', new AbortController(),
      () => new CodexClient(process.execPath, f.root, { args: [fixture, scenario, record] })), { code: scenario === 'goal-active' ? 'fork_native_goal_unsupported' : 'fork_unsupported' });
    const messages = readFileSync(record, 'utf8').trim().split('\n').map(s => JSON.parse(s));
    assert.ok(messages.some(r => r.method === 'thread/goal/get' && r.params.threadId === 'native-thread'));
    assert.equal(messages.some(r => ['thread/fork', 'turn/start', 'thread/resume'].includes(r.method)), false);
  } finally { f.clean(); }
});

for (const scenario of ['ok', 'missing', 'unreadable', 'wrong-id', 'missing-history', 'compacted', 'compacted-empty', 'failed', 'failed-missing-history', 'init-fails', 'setup-fails', 'plan']) test(`Claude fork identity/history checks: ${scenario}`, async () => {
  const f = setup();
  try {
    const child = f.bridge.fork({ ...f.request, ...(scenario === 'plan' ? { permissions: { runtime: 'claude' as const, permissionMode: 'plan' as const } } : {}) }), run = f.claim(child.run.id);
    let opened = false;
    const expectedMode = scenario === 'plan' ? 'plan' : 'default';
    const open = ((input: Parameters<typeof query>[0]) => {
      opened = true; assert.equal(input.options?.resume, f.first.conversation.id); assert.equal(input.options?.forkSession, true); assert.equal(input.options?.sessionId, child.conversation.id);
      return { initializationResult: async () => { if (scenario === 'setup-fails') throw new Error('Session could not be opened'); return {}; },
        setPermissionMode: async (mode: string) => { assert.equal(mode, expectedMode); }, reinitialize: async () => ({ current_permission_mode: expectedMode, hooks_applied: true }), close() {},
        async *[Symbol.asyncIterator]() {
          const incoming = (input.prompt as AsyncIterable<any>)[Symbol.asyncIterator](); await incoming.next();
          assert.throws(() => f.bridge.start({ conversationId: f.first.conversation.id, requestKey: 'parent-before', prompt: 'Next' }), { code: 'fork_in_progress' });
          if (scenario === 'init-fails') f.bridge.store.markSessionInitialized = () => { throw new BridgeError('fork_source_changed', 'Injected checkpoint failure'); };
          const id = scenario === 'wrong-id' ? f.first.conversation.id : child.conversation.id;
          yield { type: 'system', subtype: 'init', session_id: id, model: 'sonnet', permissionMode: expectedMode };
          f.bridge.start({ conversationId: f.first.conversation.id, requestKey: 'parent-after', prompt: 'Next' });
          if (scenario.startsWith('compacted')) yield { type: 'system', subtype: 'compact_boundary', session_id: id };
          yield scenario.startsWith('failed')
            ? { type: 'result', subtype: 'error_max_turns', session_id: id, is_error: true, errors: ['Turn limit'] }
            : { type: 'result', subtype: 'success', session_id: id, is_error: false, result: 'fork answer' };
          await incoming.next();
        } };
    }) as unknown as typeof query;
    const messages = (async (id: string) => {
      if (scenario === 'unreadable') throw new Error('EACCES fixture');
      return Array.from({ length: scenario === 'missing' ? 0 : id === f.first.conversation.id ? 2 :
        scenario === 'compacted-empty' ? 0 : scenario === 'compacted' ? 1 : scenario.includes('missing-history') ? 2 : 4 }, () => ({}));
    }) as unknown as typeof getSessionMessages;
    const work = runClaude(f.settings, f.bridge.store, run, child.conversation, 'child-token', new AbortController(), open, undefined, messages);
    if (['ok', 'compacted', 'failed', 'plan'].includes(scenario)) assert.equal((await work).is_error, scenario === 'failed');
    else await assert.rejects(work, { code: ['missing', 'unreadable'].includes(scenario) ? 'fork_source_missing' : scenario === 'wrong-id' ? 'session_identity_changed' : scenario === 'setup-fails' ? 'fork_setup_failed' : 'unknown_outcome' });
    if (scenario === 'compacted') assert.ok(f.bridge.store.events(run.id).some(e => (e.data as any).code === 'fork_history_compacted'));
    assert.equal(opened, !['missing', 'unreadable'].includes(scenario));
  } finally { f.clean(); }
});
