import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../src/config.js';
import { TERMINAL, type Runtime } from '../src/types.js';
import type { Bridge } from '../src/service.js';

if (process.env.AGENT_BRIDGE_LIVE !== '1') throw new Error('Set AGENT_BRIDGE_LIVE=1 to authorize native model calls. Build first.');
const root = resolve('.local/steering-' + Date.now());
const workspace = join(root, 'workspace');
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'fixture.txt'), 'This is an isolated steering acceptance workspace. No changes are needed.\n');
const { Bridge: BuiltBridge } = await import(pathToFileURL(resolve('dist/service.js')).href);
const bridge = new BuiltBridge({ ...config(false), stateDir: join(root, 'state') }) as Bridge;
const runtimes: Runtime[] = process.env.AGENT_BRIDGE_LIVE_RUNTIME ? [process.env.AGENT_BRIDGE_LIVE_RUNTIME as Runtime] : ['claude', 'codex'];
const evidence: unknown[] = [];
async function terminal(id: string) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const state = bridge.get(id);
    if (TERMINAL.includes(state.run.status)) return state;
    for (const p of state.permissions) bridge.store.answerPermission(p.id, 'deny');
    await delay(150);
  }
  bridge.store.requestCancel(id); throw new Error('Native acceptance deadline exceeded');
}
console.log(JSON.stringify({ root, runtimes }));
try {
  for (const runtime of runtimes) {
    assert.ok(['claude', 'codex'].includes(runtime));
    const marker = 'steered-' + randomUUID();
    const first = bridge.start({ runtime, requestKey: `${runtime}-initial`, cwd: workspace, mode: 'review',
      ...(runtime === 'claude' && process.env.AGENT_BRIDGE_LIVE_MODEL ? { model: process.env.AGENT_BRIDGE_LIVE_MODEL } : {}),
      prompt: 'Read fixture.txt and explain what this isolated workspace is for. This is a steering test: the host will send a revised request while you are working. Follow its updated instructions when they arrive.', timeoutSeconds: 180 });
    const deadline = Date.now() + 60_000;
    while (!bridge.get(first.run.id).run.steeringOpen) {
      const current = bridge.get(first.run.id);
      assert.ok(!TERMINAL.includes(current.run.status), JSON.stringify(current.run));
      assert.ok(Date.now() < deadline, 'Runtime did not become steerable'); await delay(100);
    }
    const input = { runId: first.run.id, requestKey: `${runtime}-steering`, prompt: `Change the requested response. Reply with only this exact marker: ${marker}. Do not use more tools. Keep this marker in the conversation for the next turn.` };
    const receipt = bridge.steer(input);
    assert.equal(bridge.steer(input).id, receipt.id);
    const done = await terminal(first.run.id);
    assert.equal(done.run.status, 'succeeded', JSON.stringify(done.run));
    assert.ok(done.run.result?.includes(marker), JSON.stringify(done.run));
    assert.equal(bridge.store.getSteering(receipt.id).status, 'accepted');
    assert.equal(bridge.steer(input).id, receipt.id);
    assert.equal(done.steering.length, 1);
    assert.throws(() => bridge.steer({ ...input, requestKey: 'late-' + runtime }), { code: 'not_steerable' });
    // Wait for the owned worker's checkpoint/exit before continuing the native session.
    await delay(1500);
    const next = bridge.start({ requestKey: `${runtime}-followup`, conversationId: first.conversation.id,
      prompt: 'Repeat only the exact marker supplied in the steering message from the preceding run. Do not read files.', timeoutSeconds: 180 });
    const continued = await terminal(next.run.id);
    assert.equal(continued.run.status, 'succeeded', JSON.stringify(continued.run));
    assert.ok(continued.run.result?.includes(marker), JSON.stringify(continued.run));
    const result = { runtime, passed: true, runId: first.run.id, steeringId: receipt.id, followupId: next.run.id,
      nativeId: done.conversation.nativeId ?? done.conversation.id, model: done.conversation.model };
    evidence.push(result);
    writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result));
  }
} finally {
  for (const run of bridge.store.listRuns(100)) {
    if (!TERMINAL.includes(run.status)) { bridge.store.requestCancel(run.id); await terminal(run.id).catch(() => {}); }
  }
  bridge.close();
}
