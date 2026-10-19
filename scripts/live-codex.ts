import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/service.js';
import { config } from '../src/config.js';
import { discoverCodexModels } from '../src/codex-models.js';
import { TERMINAL } from '../src/types.js';

if (process.env.AGENT_BRIDGE_LIVE !== '1') throw new Error('Set AGENT_BRIDGE_LIVE=1; this consumes native Codex usage.');
const root = resolve('.local', `codex-live-${Date.now()}`); mkdirSync(root, { recursive: true });
const workspace = join(root, 'workspace with spaces'); mkdirSync(workspace);
execFileSync('git', ['init', '-q', workspace]);
const nonce = `BRIDGE_${randomUUID()}`;
writeFileSync(join(workspace, 'fixture.txt'), nonce);
execFileSync('git', ['-C', workspace, 'add', 'fixture.txt']);
execFileSync('git', ['-C', workspace, '-c', 'user.name=Bridge Acceptance', '-c', 'user.email=bridge@example.invalid', 'commit', '-qm', 'Acceptance fixture']);
const settings = { ...config(false), stateDir: join(root, 'state') };
// Workers are compiled siblings of service.js; loading source would point at a nonexistent src/worker.js.
const { Bridge: CompiledBridge } = await import(new URL('../dist/service.js', import.meta.url).href) as { Bridge: typeof Bridge };
const bridge = new CompiledBridge(settings);
const catalogue = await discoverCodexModels(settings);
const selected = catalogue.models.find(m => m.isDefault)!;
assert.ok(selected); const effort = selected.supportedEffortLevels.includes('low') ? 'low' : selected.defaultEffort;
const evidence: Record<string, unknown> = { platform: process.platform, node: process.version, catalogue: catalogue.models.map(m => ({ model: m.value, efforts: m.supportedEffortLevels })), model: selected.value, effort };
writeFileSync(join(root, 'location.json'), JSON.stringify({ workspace, state: settings.stateDir }));
console.log(JSON.stringify({ root, model: selected.value, effort }));
async function wait(id: string, cancelOnCommand = false) {
  const end = Date.now() + 240_000; let cancelled = false;
  while (Date.now() < end) {
    const s = bridge.get(id);
    for (const p of s.permissions) {
      // Only this deliberately requested harmless echo is authorized by this script.
      const command = String(p.input.command ?? '');
      const echoCommand = /^(?:(?:\/bin\/(?:ba|z)?sh) -lc ['"])?(?:echo|Write-Output) ['"]?AGENT_BRIDGE_APPROVAL['"]?['"]?$/.test(command.trim()) || /^"C:\\+Windows\\+System32\\+WindowsPowerShell\\+v1\.0\\+powershell\.exe" -Command '(?:echo|Write-Output) AGENT_BRIDGE_APPROVAL'$/i.test(command.trim());
      const changes = p.input.changes as { path?: string; diff?: string; kind?: { type?: string } }[] | undefined;
      const fixtureEdit = p.tool === 'codex.fileChange' && Array.isArray(changes) && changes.length === 1 && resolve(s.conversation.cwd, changes[0]!.path ?? '') === join(s.conversation.cwd, 'bridge-write.txt') && changes[0]!.kind?.type === 'add' && changes[0]!.diff?.trim() === 'bridge write works';
      if ((p.tool === 'codex.command' && echoCommand) || fixtureEdit) bridge.store.answerPermission(p.id, 'allow');
      else { bridge.store.answerPermission(p.id, 'deny'); console.log(JSON.stringify({ denied: p.tool, input: p.input })); }
    }
    if (cancelOnCommand && !cancelled && existsSync(join(s.conversation.cwd, 'sleep.pid'))) {
      const pid = Number(readFileSync(join(s.conversation.cwd, 'sleep.pid'), 'utf8'));
      assert.ok(Number.isInteger(pid) && pid > 0); evidence.nativeSleepPid = pid;
      // bubblewrap uses a PID namespace: process.pid there is not the host PID.
      const hosts = process.platform === 'linux' ? readdirSync('/proc').filter(n => /^\d+$/.test(n)).filter(n => {
        try {
          const status = readFileSync(`/proc/${n}/status`, 'utf8');
          return Number(status.match(/^NSpid:\s+(.+)$/m)?.[1]?.trim().split(/\s+/).at(-1)) === pid &&
            realpathSync(`/proc/${n}/exe`) === realpathSync(process.execPath) &&
            realpathSync(`/proc/${n}/cwd`) === realpathSync(s.conversation.cwd);
        } catch { return false; }
      }).map(Number) : [pid];
      assert.equal(hosts.length, 1, 'Identify the exact host process before testing cancellation'); evidence.sleepPid = hosts[0];
      bridge.store.requestCancel(id); cancelled = true;
    }
    if (TERMINAL.includes(s.run.status)) return s;
    await delay(300);
  }
  bridge.store.requestCancel(id); throw new Error(`Acceptance timeout: ${id}`);
}
try {
  const review = bridge.start({ runtime: 'codex', requestKey: 'review', cwd: realpathSync.native(workspace), model: selected.value, effort,
    prompt: 'Read fixture.txt and return its exact contents. As an authorized sandbox acceptance check, attempt to create denied.txt using the shell (do not escalate or bypass restrictions). Report whether the sandbox refused the write. Do not create any other files.', timeoutSeconds: 180 });
  const reviewed = await wait(review.run.id); assert.equal(reviewed.run.status, 'succeeded', reviewed.run.result ?? reviewed.run.errorCode ?? '');
  assert.ok(reviewed.run.result?.includes(nonce)); assert.equal(existsSync(join(workspace, 'denied.txt')), false);
  evidence.review = { run: reviewed.run.id, nativeId: reviewed.conversation.nativeId, result: reviewed.run.result };
  const follow = bridge.start({ conversationId: review.conversation.id, requestKey: 'followup', prompt: 'Without using any tools or rereading files, return only the exact fixture marker from your previous turn.', timeoutSeconds: 180 });
  const followed = await wait(follow.run.id); assert.equal(followed.run.status, 'succeeded', followed.run.result ?? ''); assert.ok(followed.run.result?.includes(nonce)); assert.equal(followed.conversation.nativeId, reviewed.conversation.nativeId);
  evidence.followup = { run: followed.run.id, nativeId: followed.conversation.nativeId };
  const write = bridge.start({ runtime: 'codex', requestKey: 'write', cwd: workspace, mode: 'write', baseRef: 'HEAD', model: selected.value, effort,
    prompt: 'Create bridge-write.txt containing exactly "bridge write works" using apply_patch. Then use your command tool to execute exactly `echo AGENT_BRIDGE_APPROVAL` with sandbox_permissions=require_escalated and a justification explaining this is an authorized one-time approval test. Do not substitute an un-escalated command; if escalation is unavailable report it. No other changes.', timeoutSeconds: 180 });
  const written = await wait(write.run.id); assert.equal(written.run.status, 'succeeded', written.run.result ?? '');
  assert.equal(readFileSync(join(written.conversation.cwd, 'bridge-write.txt'), 'utf8').trim(), 'bridge write works'); assert.equal(existsSync(join(workspace, 'bridge-write.txt')), false);
  assert.ok(bridge.store.events(written.run.id, 0, 100).some(e => e.type === 'needs_input' && (e.data as { tool: string }).tool === 'codex.command' && bridge.store.getPermission(String((e.data as { permissionId: string }).permissionId)).decision === 'allow'), 'Native command approval was not exercised');
  assert.ok(bridge.store.events(written.run.id, 0, 100).some(e => { const d = e.data as { tool?: string; command?: string; exitCode?: number }; return e.type === 'tool' && d.tool === 'commandExecution' && d.exitCode === 0 && d.command?.includes('AGENT_BRIDGE_APPROVAL'); }), 'The approved native command must execute successfully');
  evidence.write = { run: written.run.id, nativeId: written.conversation.nativeId, worktree: written.conversation.cwd, result: written.run.result, permissions: bridge.store.events(written.run.id, 0, 100).filter(e => e.type === 'needs_input') };
  const cancel = bridge.start({ conversationId: write.conversation.id, requestKey: 'cancel', prompt: `Run a sandboxed Node command (no escalation) which writes process.pid to sleep.pid in the current worktree, then stays running for 90 seconds with setTimeout. Use the Node executable ${JSON.stringify(process.execPath.replaceAll('\\', '/'))}. This is an authorized cancellation test; do not create other files or substitute a shorter wait.`, timeoutSeconds: 180 });
  const cancelled = await wait(cancel.run.id, true); assert.equal(cancelled.run.status, 'cancelled', cancelled.run.result ?? '');
  assert.ok(evidence.sleepPid, 'The sandboxed long-running process must actually start before cancellation');
  const alive = () => { try { process.kill(Number(evidence.sleepPid), 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
  for (let n = 0; n < 100 && alive(); n++) await delay(50);
  assert.equal(alive(), false, 'Cancelled native sandbox command must not survive');
  evidence.cancel = { run: cancelled.run.id, status: cancelled.run.status, processExited: true };
  const resume = bridge.start({ conversationId: write.conversation.id, requestKey: 'after-cancel', prompt: 'Without tools, return the exact contents you wrote to bridge-write.txt in our first turn.', timeoutSeconds: 180 });
  const resumed = await wait(resume.run.id); assert.equal(resumed.run.status, 'succeeded', resumed.run.result ?? ''); assert.ok(resumed.run.result?.includes('bridge write works')); assert.equal(resumed.conversation.nativeId, written.conversation.nativeId);
  evidence.resumeAfterCancel = { run: resumed.run.id, nativeId: resumed.conversation.nativeId };
  evidence.passed = true;
} catch (error) { evidence.error = String(error); process.exitCode = 1; }
finally { writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); bridge.close(); console.log(JSON.stringify({ root, passed: evidence.passed ?? false, error: evidence.error })); }
