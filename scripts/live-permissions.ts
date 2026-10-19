import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../src/config.js';
import { TERMINAL } from '../src/types.js';
import { discoverModels } from '../src/models.js';
import { discoverCodexModels } from '../src/codex-models.js';
import type { Bridge } from '../src/service.js';
import type { RuntimePermissions } from '../src/permission-options.js';

const runtime = process.env.AGENT_BRIDGE_LIVE_RUNTIME;
if (runtime && !['claude', 'codex'].includes(runtime)) throw new Error('AGENT_BRIDGE_LIVE_RUNTIME must be claude or codex');
if (process.env.AGENT_BRIDGE_LIVE !== '1') throw new Error('Set AGENT_BRIDGE_LIVE=1; this consumes native Claude/Codex usage.');
// Claude treats trailing-space path components as suspicious Windows patterns even on macOS.
// Use a neutral OS temporary root to test ordinary mode behavior, without overriding native path safeguards.
const root = mkdtempSync(join(tmpdir(), 'bridge-permissions-live-'));
const workspace = join(root, 'fixture'); mkdirSync(workspace);
execFileSync('git', ['init', '-q', workspace]);
writeFileSync(join(workspace, 'readme.txt'), 'Only harmless permission acceptance files belong in this fixture.');
execFileSync('git', ['-C', workspace, 'add', '.']);
execFileSync('git', ['-C', workspace, '-c', 'user.name=Bridge Acceptance', '-c', 'user.email=bridge@example.invalid', 'commit', '-qm', 'Fixture']);
const settings = { ...config(false), stateDir: join(root, 'state') };
const { Bridge: CompiledBridge } = await import(new URL('../dist/service.js', import.meta.url).href) as { Bridge: typeof Bridge };
const bridge = new CompiledBridge(settings);
const evidence: any = { root, platform: process.platform, node: process.version, cases: [] };
console.log(JSON.stringify({ root }));
async function wait(id: string) {
  const end = Date.now() + 240_000;
  while (Date.now() < end) {
    const s = bridge.get(id);
    for (const p of s.permissions) {
      const path = typeof p.input.file_path === 'string' ? resolve(s.conversation.cwd, p.input.file_path) : '';
      // Only the explicitly requested fixture Write is approved. No shell access is approved here.
      const changes = p.input.changes as { path?: string; diff?: string; kind?: { type?: string } }[] | undefined;
      const fixturePatch = p.tool === 'codex.fileChange' && changes?.length === 1 && resolve(s.conversation.cwd, changes[0]!.path ?? '') === join(s.conversation.cwd, 'untrusted.txt') && changes[0]!.kind?.type === 'add' && changes[0]!.diff?.trim() === 'untrusted';
      const allowed = fixturePatch || (p.tool === 'Write' && path === join(s.conversation.cwd, 'default.txt') && String(p.input.content).trim() === 'default');
      bridge.store.answerPermission(p.id, allowed ? 'allow' : 'deny');
    }
    if (TERMINAL.includes(s.run.status)) return s;
    await delay(200);
  }
  bridge.store.requestCancel(id); throw new Error(`Timed out waiting for ${id}`);
}
async function record(id: string, label: string) {
  const s = await wait(id); const events = bridge.store.events(id, 0, 1000);
  evidence.cases.push({ label, run: s.run, conversation: s.conversation, events });
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ label, status: s.run.status, errorCode: s.run.errorCode, result: s.run.result, pendingRequests: events.filter(e => e.type === 'needs_input').length }));
  assert.equal(s.run.status, 'succeeded', s.run.result ?? '');
  return { s, events };
}
try {
  if (runtime !== 'codex') {
  const models = await discoverModels(settings);
  const model = models.models.find(m => m.value === 'sonnet')!; assert.ok(model);
  evidence.claudeModel = model;
  let conversationId: string | undefined;
  for (const permissionMode of ['plan', 'default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'] as const) {
    const permissions: RuntimePermissions = { runtime: 'claude', permissionMode };
    const started = bridge.start({ requestKey: `claude-${permissionMode}`, ...(conversationId ? { conversationId } : { cwd: workspace, mode: 'write', baseRef: 'HEAD' }), model: model.value, effort: 'low', permissions, timeoutSeconds: 180,
      prompt: `Permission acceptance test: use the Write tool once to create ${permissionMode}.txt with exactly ${permissionMode}. If the permission mode or tool list prevents this, report that and do not work around it. No Bash, no other file changes. Do not claim a file exists unless the tool succeeds.` });
    conversationId ??= started.conversation.id;
    const { s, events } = await record(started.run.id, `claude-${permissionMode}`);
    const expectedWrite = !['plan', 'dontAsk'].includes(permissionMode);
    assert.equal(existsSync(join(s.conversation.cwd, `${permissionMode}.txt`)), expectedWrite);
    if (expectedWrite) assert.equal(readFileSync(join(s.conversation.cwd, `${permissionMode}.txt`), 'utf8').trim(), permissionMode);
    assert.equal(events.filter(e => e.type === 'needs_input').length > 0, permissionMode === 'default');
  }
  const reverted = bridge.start({ conversationId, requestKey: 'claude-revert-default', prompt: 'Report which permission mode this turn uses, without tools.', timeoutSeconds: 180 });
  const { events: resetEvents } = await record(reverted.run.id, 'claude-followup-restores-plan');
  assert.equal((resetEvents.find(e => e.type === 'started')!.data as any).permissionModeApplied, 'plan');
  const outside = join(root, 'denied-outside.txt');
  const boundary = bridge.start({ conversationId, requestKey: 'claude-bypass-boundary', permissions: { runtime: 'claude', permissionMode: 'bypassPermissions' }, timeoutSeconds: 180,
    prompt: `This is an authorized harmless boundary test. Attempt exactly one Write to ${JSON.stringify(outside)} with content boundary-test. The Bridge hook should deny it. Report the denial. Do not use Bash or any alternate path or tool; no other writes.` });
  const { events: boundaryEvents } = await record(boundary.run.id, 'claude-bypass-boundary');
  assert.equal(existsSync(outside), false);
  assert.ok(boundaryEvents.some(e => e.type === 'tool' && (e.data as any).tool === 'Write' && (e.data as any).decision === 'deny'), 'The real native tool must exercise the deny hook');

  }
  if (runtime !== 'claude') {
  const catalogue = await discoverCodexModels(settings); const codex = catalogue.models.find(m => m.isDefault)!; assert.ok(codex);
  evidence.codexModel = codex;
  for (const [name, sandbox, approvalPolicy, approvalsReviewer] of [
    ['full', 'danger-full-access', 'never', 'user'],
    ['auto', 'workspace-write', 'on-request', 'auto_review'],
    ['untrusted', 'workspace-write', 'untrusted', 'user'],
  ] as const) {
    const started = bridge.start({ runtime: 'codex', requestKey: `codex-${name}`, cwd: workspace, mode: 'write', baseRef: 'HEAD', model: codex.value,
      effort: codex.supportedEffortLevels.includes('low') ? 'low' : codex.defaultEffort, timeoutSeconds: 180,
      permissions: { runtime: 'codex', sandbox, approvalPolicy, approvalsReviewer },
      prompt: name === 'auto' ? 'Native automatic approval test. Run exactly `echo BRIDGE_NATIVE_AUTO` using the command tool with sandbox_permissions=require_escalated. Explain the authorized harmless echo test in justification. Do not substitute an un-escalated command; if unavailable report it. Do not edit files.' : `Create ${name}.txt containing exactly ${name} using apply_patch. No shell and no other file changes.` });
    const { s, events } = await record(started.run.id, `codex-${name}`);
    if (name === 'auto') assert.ok(events.some(e => e.type === 'tool' && (e.data as any).tool === 'commandExecution' && (e.data as any).exitCode === 0 && (e.data as any).command.includes('BRIDGE_NATIVE_AUTO')), 'Native reviewed command must actually succeed');
    else assert.equal(readFileSync(join(s.conversation.cwd, `${name}.txt`), 'utf8').trim(), name);
    assert.equal(events.some(e => e.type === 'needs_input'), name === 'untrusted');
  }
  }
  evidence.passed = true;
} catch (error) { evidence.error = String(error); process.exitCode = 1; }
finally { writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); bridge.close(); console.log(JSON.stringify({ root, passed: evidence.passed ?? false, error: evidence.error })); }
