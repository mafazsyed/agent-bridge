import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Bridge } from '../src/service.js';
import { Store } from '../src/store.js';
import { captureWorkspace } from '../src/checkpoint.js';
import { recovery } from '../src/progress.js';
import { errorCode, resultErrorCode } from '../src/runtime.js';
import { effectiveStopReason } from '../src/run-diagnostics.js';
import { trackRuntime } from '../src/runtime-process.js';

function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-progress-')));
  const settings = { stateDir: join(root, 'state'), executable: 'unused', maxActive: 'unlimited' as const, staleMs: 120_000 };
  const bridge = new Bridge(settings, () => {});
  const start = bridge.start({ requestKey: randomUUID(), prompt: 'review', cwd: root });
  const token = 'fixture';
  const claim = () => { bridge.store.attachWorker(start.run.id, token, process.pid, 'fixture-identity'); bridge.store.claimRun(start.run.id, token); return bridge.store.getRun(start.run.id); };
  return { root, settings, bridge, start, token, claim, clean() { bridge.close(); rmSync(root, { recursive: true, force: true }); } };
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function repo(root: string) {
  git(root, 'init', '-q'); writeFileSync(join(root, '.gitignore'), 'state/\n'); writeFileSync(join(root, 'tracked'), 'one');
  git(root, 'add', '.'); git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
}
const endedRuntime = { pid: 123, identity: 'native', state: 'exited' as const, exitCode: 0, observedAt: 123 };

test('allowance, throttling, capacity and structured limits stay distinct; success prose is not an error', () => {
  for (const text of ["You've hit your limit · resets 12am", 'session limit reached', 'usageLimitExceeded', 'weekly allowance exhausted']) assert.equal(errorCode(text), 'allowance_exhausted');
  assert.equal(errorCode('HTTP rate limit exceeded'), 'rate_limited'); assert.equal(errorCode('model overloaded'), 'capacity');
  assert.equal(resultErrorCode({ is_error: false, subtype: 'success', result: 'Reviewed allowance and authentication failures' } as any), null);
  assert.equal(resultErrorCode({ is_error: true, subtype: 'error_max_turns', errors: ['quota discussion'] } as any), 'error_max_turns');
  assert.equal(resultErrorCode({ is_error: true, subtype: 'error_max_budget_usd', errors: [] } as any), 'error_max_budget_usd');
});

test('native allowance reason survives unknown shutdown; confirmed exit never clears transcript uncertainty', () => {
  const f = setup();
  try {
    f.claim(); f.bridge.store.recordDiagnostics(f.start.run.id, f.token, { stopReason: 'allowance_exhausted', nativeCode: 'allowance_exhausted', dispatch: 'sent', transcript: 'unverified', shutdown: 'unverified', runtime: endedRuntime });
    f.bridge.store.finishRun(f.start.run.id, f.token, 'unknown', 'Allowance exhausted', 'unknown_outcome');
    const r = recovery(f.bridge.store.getRun(f.start.run.id), () => false);
    assert.equal(r.stopReason, 'allowance_exhausted'); assert.equal(r.worker, 'exited'); assert.equal(r.runtime, 'exited');
    assert.equal(r.readyForHandoff, true); assert.equal(r.nextAction, 'inspect');
    const stable = { ...f.bridge.store.getRun(f.start.run.id), status: 'failed' as const, diagnostics: { ...f.bridge.store.getRun(f.start.run.id).diagnostics, transcript: 'runtime_reported' as const, shutdown: 'clean' as const } };
    assert.equal(recovery(stable, () => false).nextAction, 'retry_when_available');
    assert.equal(f.bridge.store.recordDiagnostics(f.start.run.id, 'other-owner', { stopReason: 'completed' }), false);
  } finally { f.clean(); }
});

test('handover checks owned identities, PID reuse, inconclusive probes, active workers and later runs', () => {
  const f = setup();
  try {
    f.claim(); f.bridge.store.recordDiagnostics(f.start.run.id, f.token, { stopReason: 'completed', dispatch: 'sent', transcript: 'runtime_reported', shutdown: 'clean', runtime: { ...endedRuntime, state: 'running' } });
    f.bridge.store.finishRun(f.start.run.id, f.token, 'succeeded'); const run = f.bridge.store.getRun(f.start.run.id);
    assert.equal(recovery(run, () => true, () => null).nextAction, 'wait');
    assert.equal(recovery(run, () => false, () => 'native').readyForHandoff, false);
    assert.equal(recovery(run, () => false, () => undefined).readyForHandoff, false);
    assert.equal(recovery(run, () => undefined, () => null).readyForHandoff, false);
    assert.equal(recovery(run, () => false, () => 'reused-pid').nextAction, 'continue');
    assert.equal(recovery(run, () => false, () => null, ['next-turn']).readyForHandoff, false);
    const next = f.bridge.start({ requestKey: 'next', conversationId: f.start.conversation.id, prompt: 'Continue' });
    const progress = f.bridge.progress(run.id);
    assert.equal(progress.recovery.nextAction, 'wait'); assert.deepEqual(progress.recovery.activeRunIds, [next.run.id]);
    assert.equal(effectiveStopReason({ ...run, status: 'unknown', errorCode: null, diagnostics: null }), 'uncertain');
    assert.equal(effectiveStopReason({ ...run, status: 'cancelled', errorCode: null, diagnostics: null }), 'cancelled');
    assert.equal(recovery({ ...run, diagnostics: null }, () => false).readyForHandoff, false, 'Legacy runtime exit cannot be invented');
  } finally { f.clean(); }
});

test('queued cancellation has no runtime or worker to wait for; active progress avoids OS probes', () => {
  const f = setup();
  try {
    const pending = f.claim(); const forbidden = () => { throw new Error('active progress must not invoke OS'); };
    assert.equal(recovery(pending, forbidden, forbidden).nextAction, 'wait');
    const next = f.bridge.start({ requestKey: 'cancel-pending', cwd: f.root, prompt: 'No dispatch' });
    const cancelled = f.bridge.store.requestCancel(next.run.id);
    assert.equal(recovery(cancelled, forbidden, forbidden).readyForHandoff, true);
    assert.equal(recovery(cancelled).stopReason, 'cancelled');
  } finally { f.clean(); }
});

test('owned child tracking waits for actual exit, and spawn failures are not started', async () => {
  const f = setup(); let child: ReturnType<typeof spawn> | undefined;
  try {
    f.claim(); child = spawn(process.execPath, ['-e', "process.stdin.once('data', () => process.exit(7)); process.stdin.resume();"], { stdio: ['pipe', 'ignore', 'ignore'] });
    const done = trackRuntime(child, f.bridge.store, f.start.run.id, f.token);
    assert.equal(await done(1), false); assert.equal(f.bridge.store.getRun(f.start.run.id).diagnostics?.runtime?.state, 'running');
    child.stdin!.end('finish');
    assert.equal(await done(3000), true); assert.equal(f.bridge.store.getRun(f.start.run.id).diagnostics?.runtime?.exitCode, 7);
    const missing = spawn(join(f.root, 'not-an-executable'), [], { stdio: 'ignore' });
    const failed = trackRuntime(missing, f.bridge.store, f.start.run.id, f.token);
    assert.equal(await failed(), true); assert.equal(f.bridge.store.getRun(f.start.run.id).diagnostics?.runtime?.state, 'not_started');
  } finally { if (child?.exitCode === null) child.kill(); f.clean(); }
});

test('checkpoint captures dirty names, renames, HEAD and branch without changing the index', async () => {
  const f = setup();
  try {
    repo(f.root); const clean = await captureWorkspace(f.root);
    assert.equal(clean.status, 'observed'); assert.equal(clean.clean, true); assert.equal(clean.commit, git(f.root, 'rev-parse', 'HEAD')); assert.ok(clean.branch);
    renameSync(join(f.root, 'tracked'), join(f.root, 'renamed with spaces')); git(f.root, 'add', '-A');
    writeFileSync(join(f.root, '.hidden'), 'test'); if (process.platform !== 'win32') writeFileSync(join(f.root, 'line\nbreak'), 'test');
    const index = readFileSync(join(f.root, '.git', 'index'));
    const result = await f.bridge.checkpoint(f.start.run.id);
    assert.deepEqual(readFileSync(join(f.root, '.git', 'index')), index);
    assert.equal(result.workspace.clean, false); assert.ok(result.workspace.dirtyFiles.some(x => x.path === 'renamed with spaces' && x.from === 'tracked'));
    assert.ok(result.workspace.dirtyFiles.some(x => x.path === '.hidden'));
    if (process.platform !== 'win32') assert.ok(result.workspace.dirtyFiles.some(x => x.path === 'line\nbreak'));
    assert.deepEqual(f.bridge.progress(f.start.run.id).workspace, result.workspace);
    git(f.root, 'checkout', '--detach', '-q'); assert.equal((await captureWorkspace(f.root)).branch, null);
  } finally { f.clean(); }
});

test('checkpoint handles unborn, unavailable and large repositories honestly and ignores inherited Git target', async () => {
  const f = setup(); const before = process.env.GIT_DIR;
  try {
    assert.equal((await captureWorkspace(f.root)).clean, null); git(f.root, 'init', '-q');
    process.env.GIT_DIR = '/not/the/workspace'; const unborn = await captureWorkspace(f.root); assert.equal(unborn.status, 'observed'); assert.equal(unborn.commit, null);
    mkdirSync(join(f.root, 'many')); for (let i = 0; i < 210; i++) writeFileSync(join(f.root, 'many', `${i}`), '');
    const large = await captureWorkspace(f.root); assert.equal(large.truncated, true); assert.equal(large.dirtyFiles.length, 200); assert.equal(large.clean, false);
  } finally { if (before === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = before; f.clean(); }
});

test('normalized transcript deduplicates identity, preserves distinct equal text, and pages updated revisions', () => {
  const f = setup();
  try {
    const id = f.start.run.id, s = f.bridge.store;
    const a = s.appendEvent(id, 'text', { text: 'first', messageKey: 'native:first' }, 'frame1');
    assert.equal(s.appendEvent(id, 'text', { text: 'first', messageKey: 'native:first' }, 'frame1').seq, a.seq);
    const b = s.appendEvent(id, 'text', { text: 'first', messageKey: 'native:second' }, 'frame2');
    const revised = s.appendEvent(id, 'text', { text: 'updated', messageKey: 'native:first' }, 'frame3');
    assert.equal(s.events(id).length, 3);
    const page1 = f.bridge.transcript(id, 0, 1); assert.equal(page1.events[0]?.seq, b.seq); assert.equal(page1.mayHaveMore, true);
    const page2 = f.bridge.transcript(id, page1.nextCursor, 1); assert.equal(page2.events[0]?.seq, revised.seq); assert.equal(page2.mayHaveMore, false);
    const again = s.appendEvent(id, 'text', { text: 'newest', messageKey: 'native:first' }, 'frame4');
    assert.equal(f.bridge.transcript(id, page2.nextCursor).events[0]?.seq, again.seq);
    for (let i = 0; i < 102; i++) s.appendEvent(id, 'text', { text: `${i}` });
    assert.equal(f.bridge.transcript(id, again.seq, 100).events.length, 100); assert.equal(f.bridge.transcript(id, again.seq, 100).mayHaveMore, true);
  } finally { f.clean(); }
});

test('progress distinguishes claims from commands; handoffs require same-run evidence and never clear uncertainty', async () => {
  const f = setup();
  try {
    const run = f.claim(), s = f.bridge.store;
    const claim = s.appendEvent(run.id, 'text', { text: 'All tests pass' });
    const command = s.appendEvent(run.id, 'command_result', { command: 'npm test', exitCode: 1, status: 'tool_completed' });
    s.finishRun(run.id, f.token, 'unknown', 'unknown result', 'unknown_outcome');
    const value = f.bridge.handoff({ runId: run.id, summary: 'Checkpoint', unfinishedWork: ['Fix failing test'], checks: [{ description: 'npm test', result: 'failed', evidenceSeq: command.seq }] });
    assert.equal(value.handoff?.source, 'host_reported'); assert.equal(value.recovery.stopReason, 'uncertain');
    assert.equal(value.activity.find(x => x.seq === claim.seq)?.category, 'agent_report'); assert.equal(value.activity.find(x => x.seq === command.seq)?.category, 'command_result');
    assert.equal(value.activity.find(x => x.seq === command.seq)?.exitCode, 1);
    const other = f.bridge.start({ requestKey: 'other', prompt: 'Elsewhere', cwd: f.root });
    const foreign = s.appendEvent(other.run.id, 'text', { text: 'foreign' });
    assert.throws(() => f.bridge.handoff({ runId: run.id, summary: 'bad evidence', checks: [{ description: 'check', result: 'passed', evidenceSeq: foreign.seq }] }), { code: 'invalid_evidence' });
    const depth = process.env.AGENT_BRIDGE_DELEGATION_DEPTH; process.env.AGENT_BRIDGE_DELEGATION_DEPTH = '1';
    try {
      assert.throws(() => f.bridge.handoff({ runId: run.id, summary: 'self-verified' }), { code: 'delegation_loop' });
      await assert.rejects(f.bridge.checkpoint(run.id), { code: 'delegation_loop' });
      assert.equal(f.bridge.progress(run.id).handoff?.summary, 'Checkpoint');
    } finally { if (depth === undefined) delete process.env.AGENT_BRIDGE_DELEGATION_DEPTH; else process.env.AGENT_BRIDGE_DELEGATION_DEPTH = depth; }
    s.prune(Date.now() + 1000); assert.equal(s.getRun(run.id).handoff, null); assert.equal(f.bridge.transcript(run.id).events.length, 0);
    f.bridge.handoff({ runId: run.id, summary: 'Refreshed after pruning' }); await f.bridge.checkpoint(run.id);
    s.prune(Date.now() + 1000); assert.equal(s.getRun(run.id).handoff, null); assert.equal(s.getRun(run.id).checkpoint, null);
  } finally { f.clean(); }
});

test('schema 5 migrates diagnostics as unknown without fabricating exit or losing idempotency', () => {
  const f = setup(); const run = f.claim(); f.bridge.store.finishRun(run.id, f.token, 'unknown', 'legacy failure', 'unknown_outcome');
  f.bridge.close(); const db = new DatabaseSync(join(f.settings.stateDir, 'bridge.sqlite'));
  db.exec('ALTER TABLE runs DROP COLUMN diagnostics_json; ALTER TABLE runs DROP COLUMN checkpoint_json; ALTER TABLE runs DROP COLUMN handoff_json; DROP INDEX events_source; ALTER TABLE events DROP COLUMN source_key; PRAGMA user_version=5'); db.close();
  const store = new Store(f.settings.stateDir);
  try {
    const legacy = store.getRun(run.id); assert.equal(legacy.result, 'legacy failure'); assert.equal(legacy.diagnostics, null);
    assert.equal(recovery(legacy, () => false).runtime, 'unverified'); assert.equal(store.findByRequestKey(f.start.run.requestKey)?.id, run.id);
    store.appendEvent(run.id, 'text', { text: 'new schema' }, 'new-source');
  } finally { store.close(); rmSync(f.root, { recursive: true, force: true }); }
});
