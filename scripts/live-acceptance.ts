import { Bridge } from '../src/service.js';
import { config } from '../src/config.js';
import { TERMINAL } from '../src/types.js';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Opt-in: calls the user's authenticated Claude runtime and consumes model usage.
if (process.env.AGENT_BRIDGE_LIVE !== '1') throw new Error('Set AGENT_BRIDGE_LIVE=1 to authorize live model calls. Build first.');
const root = resolve('.local/live-' + Date.now());
// Win32 normalizes trailing spaces; keep embedded spaces on every platform.
const workspace = join(root, process.platform === 'win32' ? 'workspace with spaces' : 'workspace ');
mkdirSync(workspace, { recursive: true });
const marker = 'violet-' + randomUUID();
writeFileSync(join(workspace, 'fixture.txt'), marker);
const settings = { ...config(), stateDir: join(root, 'state') };
// Compile-time source import is intentional, but workers must launch from built distribution.
const { Bridge: BuiltBridge } = await import(pathToFileURL(resolve('dist/service.js')).href);
const bridge = new BuiltBridge(settings) as Bridge;
const evidence: unknown[] = [];
async function until(id: string, handler?: (snapshot: ReturnType<Bridge['get']>) => Promise<void>) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const s = bridge.get(id);
    if (handler) await handler(s);
    if (TERMINAL.includes(s.run.status)) return s;
    await delay(500);
  }
  bridge.store.requestCancel(id);
  throw new Error(`Acceptance timed out for ${id}`);
}
try {
  const first = bridge.start({ requestKey: 'review', cwd: workspace, prompt: 'Read fixture.txt. Report its exact contents. Also try to create a file called forbidden.txt containing hello, if your permitted tools allow it. Do not use shell commands.', timeoutSeconds: 180 });
  const second = bridge.start({ requestKey: 'followup', conversationId: first.conversation.id, prompt: 'Repeat only the marker you just read in the previous turn, without re-reading files.', timeoutSeconds: 180 });
  const a = await until(first.run.id), b = await until(second.run.id);
  assert.equal(a.run.status, 'succeeded', JSON.stringify(a));
  assert.ok(a.run.result?.includes(marker));
  assert.equal(b.run.status, 'succeeded', JSON.stringify(b));
  assert.ok(b.run.result?.includes(marker));
  assert.equal(existsSync(join(workspace, 'forbidden.txt')), false);
  evidence.push({ check: 'review, queued follow-up, context, no write', passed: true, runs: [a.run.id, b.run.id] });

  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
  git('init', '-b', 'main'); git('add', 'fixture.txt');
  git('-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture');
  const write = bridge.start({ requestKey: 'write', cwd: workspace, mode: 'write', baseRef: 'HEAD', prompt: 'Create hello.txt containing exactly bridge works using Write. Then run the shell command `git diff --stat` to inspect your changes, requesting permission through the host. Return a concise summary. Do not commit or push.', timeoutSeconds: 180 });
  let approvals = 0;
  const c = await until(write.run.id, async s => {
    for (const p of s.permissions) {
      assert.equal(p.tool, 'Bash');
      const command = String(p.input.command);
      // Only this harmless diagnostic command is authorized by this acceptance script.
      const approved = command === 'git diff --stat';
      bridge.store.answerPermission(p.id, approved ? 'allow' : 'deny');
      if (approved) approvals++;
    }
  });
  assert.equal(c.run.status, 'succeeded', JSON.stringify(c));
  assert.match(readFileSync(join(c.conversation.cwd, 'hello.txt'), 'utf8'), /^bridge works\s*$/);
  assert.equal(existsSync(join(workspace, 'hello.txt')), false);
  assert.ok(approvals > 0, 'Expected a real command permission request');
  evidence.push({ check: 'isolated write and exact command approval', passed: true, run: c.run.id });
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root, passed: true, evidence }));
} finally { bridge.close(); }
