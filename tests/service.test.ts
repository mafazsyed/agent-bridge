import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/service.js';
import { config } from '../src/config.js';

test('service repeats exact submissions safely, queues followups and keeps mode immutable', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-service-')));
  const settings = { stateDir: join(root, 'state'), executable: 'unused-fixture', maxActive: 1, staleMs: 120_000 };
  let launches = 0;
  const bridge = new Bridge(settings, () => { launches++; });
  try {
    const input = { requestKey: randomUUID(), prompt: 'Read only fixture', cwd: root };
    const first = bridge.start(input);
    const duplicate = bridge.start(input);
    assert.equal(first.run.id, duplicate.run.id);
    assert.equal(launches, 1);
    assert.equal(first.conversation.mode, 'review');
    assert.throws(() => bridge.start({ ...input, prompt: 'Different' }), /different input/);
    const followup = bridge.start({ requestKey: randomUUID(), conversationId: first.conversation.id, prompt: 'Continue' });
    assert.equal(followup.conversation.cwd, first.conversation.cwd);
    assert.equal(followup.run.status, 'queued');
    assert.equal(launches, 2);
    assert.throws(() => bridge.start({ requestKey: randomUUID(), conversationId: first.conversation.id, prompt: 'Change scope', mode: 'write' }), /saved workspace/);
    assert.throws(() => bridge.start({ requestKey: randomUUID(), prompt: 'No cwd' }), /explicit workspace/);
    assert.throws(() => bridge.start({ requestKey: randomUUID(), prompt: 'Relative cwd', cwd: '.' }), /absolute path/);
    bridge.store.appendEvent(first.run.id, 'fixture', { safe: true });
    const state = await bridge.wait(first.run.id, 0, 0);
    assert.equal(state.events.length, 1);
    assert.ok(state.nextCursor > 0);
    assert.ok(!('workerToken' in state.run));
    assert.ok(!('prompt' in state.run));
  } finally { bridge.close(); rmSync(root, { recursive: true, force: true }); }
});

test('startup failure becomes a durable terminal record', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-start-fail-')));
  const bridge = new Bridge({ stateDir: join(root, 'state'), executable: 'unused', maxActive: 1, staleMs: 120_000 }, () => { throw new Error('launcher unavailable'); });
  try {
    const input = { requestKey: randomUUID(), prompt: 'fixture', cwd: root };
    assert.throws(() => bridge.start(input), /launcher unavailable/);
    const saved = bridge.start(input);
    assert.equal(saved.run.status, 'failed');
    assert.equal(saved.run.errorCode, 'worker_start_failed');
  } finally { bridge.close(); rmSync(root, { recursive: true, force: true }); }
});

test('configuration rejects unbounded concurrency', () => {
  const prev = process.env.AGENT_BRIDGE_MAX_ACTIVE;
  const oldPath = process.env.AGENT_BRIDGE_CLAUDE_PATH;
  try {
    process.env.AGENT_BRIDGE_CLAUDE_PATH = process.execPath;
    process.env.AGENT_BRIDGE_MAX_ACTIVE = '99';
    assert.throws(config, /must be 1/);
  } finally {
    if (prev === undefined) delete process.env.AGENT_BRIDGE_MAX_ACTIVE; else process.env.AGENT_BRIDGE_MAX_ACTIVE = prev;
    if (oldPath === undefined) delete process.env.AGENT_BRIDGE_CLAUDE_PATH; else process.env.AGENT_BRIDGE_CLAUDE_PATH = oldPath;
  }
});
