import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import type { Bridge } from '../src/service.js';
if (process.env.AGENT_BRIDGE_LIVE !== '1') throw new Error('Set AGENT_BRIDGE_LIVE=1 to authorize model calls.');
const root = resolve('.local/control-' + Date.now()); mkdirSync(root, { recursive: true });
const { Bridge: BuiltBridge } = await import(pathToFileURL(resolve('dist/service.js')).href);
const bridge = new BuiltBridge({ ...config(), stateDir: join(root, 'state') }) as Bridge;
const question = 'Use AskUserQuestion to ask one question, "Which colour?", with options Blue and Green. Wait for my answer through that tool. Then reply only with the selected colour.';
const evidence: unknown[] = [];
async function wait(id: string, action?: (state: ReturnType<Bridge['get']>) => void) {
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    const state = bridge.get(id); action?.(state);
    if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(state.run.status)) return state;
    await delay(250);
  }
  bridge.store.requestCancel(id); throw new Error('Control acceptance timed out');
}
try {
  const a = bridge.start({ requestKey: 'question', cwd: root, prompt: question, timeoutSeconds: 150 });
  let answered = false;
  const first = await wait(a.run.id, s => {
    for (const p of s.permissions) {
      assert.equal(p.tool, 'AskUserQuestion');
      const qs = p.input.questions as { question: string }[];
      bridge.store.answerPermission(p.id, 'allow', Object.fromEntries(qs.map(q => [q.question, 'Blue'])));
      answered = true;
    }
  });
  assert.equal(first.run.status, 'succeeded', JSON.stringify(first)); assert.ok(answered); assert.match(first.run.result!, /blue/i);
  evidence.push({ check: 'native question and host answer', passed: true });
  const b = bridge.start({ requestKey: 'cancel', cwd: root, prompt: question, timeoutSeconds: 150 });
  let cancelled = false;
  const second = await wait(b.run.id, s => {
    if (!cancelled && s.permissions.length) {
      bridge.store.requestCancel(b.run.id); cancelled = true;
      assert.throws(() => bridge.store.answerPermission(s.permissions[0]!.id, 'allow', { 'Which colour?': 'Blue' }), /Cancellation/);
    }
  });
  assert.ok(cancelled); assert.equal(second.run.status, 'cancelled', JSON.stringify(second));
  const c = bridge.start({ requestKey: 'resume-cancelled', conversationId: b.conversation.id, prompt: 'The previous question is cancelled. Use no tools. Reply only: resumed successfully', timeoutSeconds: 150 });
  const third = await wait(c.run.id);
  assert.equal(third.run.status, 'succeeded', JSON.stringify(third)); assert.match(third.run.result!, /resumed successfully/i);
  evidence.push({ check: 'native cancellation, late-answer refusal and resume', passed: true });
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ root, evidence }));
} finally { bridge.close(); }
