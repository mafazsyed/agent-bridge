import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/service.js';
import { CodexClient } from '../src/codex-client.js';
import { codexModels } from '../src/codex-models.js';
import { runCodex } from '../src/codex-runtime.js';
import { discoverAccountLimits } from '../src/limits.js';
const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
function setup(scenario: string, mode: 'review' | 'write' = 'review') {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-codex-'))); const record = join(root, 'rpc.jsonl');
  const settings = { stateDir: join(root, 'state'), executable: '', codexExecutable: process.execPath, maxActive: 1, staleMs: 120_000 };
  const bridge = new Bridge(settings, () => {});
  const start = bridge.start({ runtime: 'codex', requestKey: scenario, prompt: 'Fixture', cwd: root });
  bridge.store.attachWorker(start.run.id, 'fixture', process.pid); bridge.store.claimRun(start.run.id, 'fixture');
  const run = bridge.store.getRun(start.run.id), conversation = { ...start.conversation, mode };
  const abort = new AbortController();
  const open = () => new CodexClient(process.execPath, root, { args: [fixture, scenario, record], requestTimeoutMs: 2000 });
  const events = () => existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  return { root, bridge, run, conversation, settings, abort, open, events, clean: () => { bridge.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
test('Codex discovery reads all native model pages without creating a thread', async () => {
  const f = setup('discovery'); const client = f.open();
  try { await client.initialize(); assert.equal((await codexModels(client))[0]?.model, 'native-model'); await client.close(); assert.equal(f.events().filter(e => e.method?.startsWith('thread/') || e.method?.startsWith('turn/')).length, 0); }
  finally { await client.close(); f.clean(); }
});
test('Codex account limit probe uses real stdio without creating threads or leaking identity', async () => {
  const f = setup('limits');
  try {
    const result = await discoverAccountLimits(f.settings, 'codex', { openCodex: f.open });
    assert.equal(result.buckets[0]?.windows[0]?.window?.usedPercent, 12);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(f.events().some(e => /^(thread|turn)\//.test(e.method ?? '')), false);
  } finally { f.clean(); }
});
for (const scenario of ['usage', 'usage-interrupted']) test(`Codex usage filters foreign identities and retains partial accounting: ${scenario}`, async () => {
  const f = setup(scenario);
  try {
    const work = runCodex(f.settings, f.bridge.store, f.run, f.conversation, 'fixture', f.abort, f.open);
    if (scenario === 'usage-interrupted') await assert.rejects(work, { code: 'unknown_outcome' });
    else await work;
    const usage = f.bridge.get(f.run.id).run.usage;
    assert.equal(usage?.cumulative.tokens?.total, 100);
    assert.equal(usage?.lastReported?.input, 10);
    assert.equal(usage?.status, scenario === 'usage' ? 'reported' : 'partial');
  } finally { f.clean(); }
});
test('usage storage failure cannot fail Codex transport or change a completed result', async () => {
  const f = setup('usage');
  let attempts = 0;
  try {
    f.bridge.store.recordUsage = () => { attempts++; throw new Error('Simulated disk failure'); };
    const result = await runCodex(f.settings, f.bridge.store, f.run, f.conversation, 'fixture', f.abort, f.open);
    assert.equal(result.success, true); assert.equal(result.text, 'native result');
    assert.equal(attempts, 2, 'Exercise both the streamed snapshot and terminal update');
  } finally { f.clean(); }
});
for (const scenario of ['basic', 'early-complete', 'unknown-request']) test(`Codex completes ${scenario} and records native identity before dispatch`, async () => {
  const f = setup(scenario);
  try {
    const result = await runCodex(f.settings, f.bridge.store, f.run, f.conversation, 'fixture', f.abort, f.open);
    assert.equal(result.success, true); assert.equal(result.text, 'native result');
    const saved = f.bridge.store.getConversation(f.conversation.id); assert.equal(saved.nativeId, 'native-thread'); assert.equal(saved.model, 'native-model');
    const start = f.events().find(e => e.method === 'thread/start'); assert.equal(start.params.approvalPolicy, 'never');
    assert.equal(start.params.config['windows.sandbox'], undefined, 'Never downgrade the native Windows sandbox');
    assert.equal(start.params.config.mcp_servers['bridge.with.dot'].enabled, false);
    assert.equal(f.events().find(e => e.method === 'turn/start').params.effort, 'high');
  } finally { f.clean(); }
});
for (const [scenario, code] of [['signed-out', 'auth_required'], ['unsafe', 'sandbox_unavailable'], ['mcp-enabled', 'external_tools_enabled'], ['before-dispatch-crash', 'codex_transport'], ['after-dispatch-crash', 'unknown_outcome'], ['invalid-json', 'unknown_outcome']]) test(`Codex fails safely: ${scenario}`, async () => {
  const f = setup(scenario!);
  try { await assert.rejects(runCodex(f.settings, f.bridge.store, f.run, f.conversation, 'fixture', f.abort, f.open), { code }); }
  finally { f.clean(); }
});
test('Codex resumes the saved native thread and refuses identity substitution', async () => {
  const f = setup('wrong-resume');
  try { await assert.rejects(runCodex(f.settings, f.bridge.store, f.run, { ...f.conversation, nativeId: 'native-thread' }, 'fixture', f.abort, f.open), { code: 'session_identity_changed' }); assert.equal(f.events().some(e => e.method === 'turn/start'), false); assert.equal(f.events().find(e => e.method === 'thread/resume').params.threadId, 'native-thread'); }
  finally { f.clean(); }
});
for (const scenario of ['approval', 'file', 'question', 'foreign-approval', 'resolved', 'stdin-approval', 'patch-updated', 'empty-patch', 'patch-pending']) test(`Codex permission lifecycle: ${scenario}`, async () => {
  const f = setup(scenario, 'write');
  let answered = false;
  const timer = setInterval(() => {
    const p = f.bridge.store.pendingPermissions(f.run.id)[0]; if (!p || scenario === 'resolved' || scenario === 'patch-pending') return;
    if (scenario === 'patch-updated') assert.deepEqual(p.input.changes, [{ path: 'new.txt', diff: '+updated' }]);
    f.bridge.store.answerPermission(p.id, 'allow', scenario === 'question' ? { 'Which colour?': 'Blue' } : undefined); answered = true;
  }, 20);
  try {
    await runCodex(f.settings, f.bridge.store, f.run, f.conversation, 'fixture', f.abort, f.open);
    assert.equal(answered, !['foreign-approval', 'resolved', 'stdin-approval', 'empty-patch', 'patch-pending'].includes(scenario));
    if (scenario === 'approval') assert.deepEqual(f.events().find(e => e.decision).decision, { decision: 'accept' });
    if (scenario === 'stdin-approval') assert.deepEqual(f.events().find(e => e.decision).decision, { decision: 'decline' });
    if (scenario === 'empty-patch' || scenario === 'patch-pending') assert.deepEqual(f.events().find(e => e.fileDecision).fileDecision, { decision: 'decline' });
    if (scenario === 'question') assert.deepEqual(f.events().find(e => e.questionAnswer).questionAnswer, { answers: { colour: { answers: ['Blue'] } } });
    assert.equal(f.bridge.store.pendingPermissions(f.run.id).length, 0);
  } finally { clearInterval(timer); f.clean(); }
});
test('Codex review mode declines even a native escalation request', async () => {
  const f = setup('approval');
  try { await runCodex(f.settings, f.bridge.store, f.run, f.conversation, 'fixture', f.abort, f.open); assert.deepEqual(f.events().find(e => e.decision).decision, { decision: 'decline' }); }
  finally { f.clean(); }
});
test('Codex cancellation interrupts the exact turn and kills owned grandchildren', async () => {
  const f = setup('cancel');
  const pending = runCodex(f.settings, f.bridge.store, f.run, f.conversation, 'fixture', f.abort, f.open);
  void pending.catch(() => {});
  try {
    let pid: number | undefined;
    for (let i = 0; i < 200 && !pid; i++) { pid = f.events().find(e => e.grandchild)?.grandchild; await delay(20); }
    assert.ok(pid); f.abort.abort(); await assert.rejects(pending, { code: 'unknown_outcome' });
    assert.equal(f.events().find(e => e.method === 'turn/interrupt').params.turnId, 'native-turn');
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) { try { process.kill(pid, 0); } catch { alive = false; } if (alive) await delay(20); }
    assert.equal(alive, false);
  } finally { f.abort.abort(); await pending.catch(() => {}); f.clean(); }
});

test('Codex abort during startup closes pending RPCs without an uncertain dispatch', async () => {
  const f = setup('startup-hang');
  const pending = runCodex(f.settings, f.bridge.store, f.run, f.conversation, 'fixture', f.abort, f.open);
  try {
    for (let i = 0; i < 100 && !f.events().length; i++) await delay(10);
    f.abort.abort(); await assert.rejects(pending, { code: 'codex_closed' });
    assert.equal(f.events().some(e => e.method === 'turn/start'), false);
  } finally { await pending.catch(() => {}); f.clean(); }
});

for (const permissions of [
  { runtime: 'codex', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
  { runtime: 'codex', sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' },
  { runtime: 'codex', sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user' },
  { runtime: 'codex', sandbox: 'workspace-write', approvalPolicy: { granular: { sandbox_approval: true, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: false } }, approvalsReviewer: 'user' },
] as const) test(`Codex forwards and verifies explicit native permissions: ${JSON.stringify(permissions)}`, async () => {
  const f = setup('early-complete', 'write');
  try {
    await runCodex(f.settings, f.bridge.store, { ...f.run, permissions }, f.conversation, 'fixture', f.abort, f.open);
    for (const method of ['thread/start', 'turn/start']) {
      const params = f.events().find(e => e.method === method).params;
      assert.deepEqual(params.approvalPolicy, permissions.approvalPolicy); assert.equal(params.approvalsReviewer, permissions.approvalsReviewer);
    }
    const applied = f.bridge.store.events(f.run.id).find(e => e.type === 'started')!.data as any;
    assert.deepEqual(applied.permissionsRequested, permissions);
  } finally { f.clean(); }
});
for (const scenario of ['reviewer-downgrade', 'policy-downgrade']) test(`Codex refuses changed permissions before dispatch: ${scenario}`, async () => {
  const f = setup(scenario, 'write');
  try {
    await assert.rejects(runCodex(f.settings, f.bridge.store, { ...f.run, permissions: { runtime: 'codex', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' } }, f.conversation, 'fixture', f.abort, f.open), { code: 'sandbox_unavailable' });
    assert.equal(f.events().some(e => e.method === 'turn/start'), false);
  } finally { f.clean(); }
});
test('Codex never policy does not forward an unexpected native escalation', async () => {
  const f = setup('approval', 'write');
  try {
    await runCodex(f.settings, f.bridge.store, { ...f.run, permissions: { runtime: 'codex', sandbox: 'workspace-write', approvalPolicy: 'never', approvalsReviewer: 'user' } }, f.conversation, 'fixture', f.abort, f.open);
    assert.deepEqual(f.events().find(e => e.decision).decision, { decision: 'decline' });
    assert.equal(f.bridge.store.events(f.run.id).some(e => e.type === 'needs_input'), false);
  } finally { f.clean(); }
});
