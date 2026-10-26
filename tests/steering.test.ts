import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import { Bridge } from '../src/service.js';
import { Store } from '../src/store.js';
import { runClaude } from '../src/runtime.js';

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-steering-')));
  const settings = { stateDir: join(root, 'state'), executable: 'fixture', maxActive: 1, staleMs: 120_000 };
  const bridge = new Bridge(settings, () => {});
  const started = bridge.start({ requestKey: 'start', cwd: root, prompt: 'Original task' });
  const run = bridge.store.getRun(started.run.id), conversation = started.conversation;
  const input = { runId: run.id, requestKey: 'steer', prompt: 'Focus on the tests first' };
  const activate = () => { bridge.store.attachWorker(run.id, 'owner', process.pid); bridge.store.claimRun(run.id, 'owner'); bridge.store.openSteering(run.id, 'owner'); };
  return { root, settings, bridge, run, conversation, input, activate, clean() { bridge.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out'); await delay(10); }
}

test('steering admission, persistence, idempotency and worker ownership', () => {
  const f = fixture();
  try {
    assert.throws(() => f.bridge.steer(f.input), { code: 'not_steerable' });
    f.bridge.store.attachWorker(f.run.id, 'owner', process.pid); f.bridge.store.claimRun(f.run.id, 'owner');
    assert.throws(() => f.bridge.steer(f.input), { code: 'not_steerable' }, 'Startup is not a steerable turn');
    assert.equal(f.bridge.store.openSteering(f.run.id, 'imposter'), false);
    f.bridge.store.openSteering(f.run.id, 'owner');
    const receipt = f.bridge.steer(f.input);
    assert.equal(receipt.status, 'pending');
    const second = new Store(f.settings.stateDir);
    try {
      assert.equal(second.requestSteering(f.input).id, receipt.id);
      assert.throws(() => second.requestSteering({ ...f.input, prompt: 'Different' }), { code: 'idempotency_conflict' });
      assert.equal(second.claimSteering(f.run.id, 'imposter'), null);
      assert.equal(second.claimSteering(f.run.id, 'owner')?.id, receipt.id);
      assert.equal(f.bridge.store.claimSteering(f.run.id, 'owner'), null);
      second.settleSteering(receipt.id, 'imposter', 'accepted');
      assert.equal(second.getSteering(receipt.id).status, 'dispatching');
      second.settleSteering(receipt.id, 'owner', 'accepted');
      assert.equal(f.bridge.steer(f.input).status, 'accepted');
      assert.equal(f.bridge.get(f.run.id).steering.length, 1);
    } finally { second.close(); }
    f.bridge.store.finishRun(f.run.id, 'owner', 'succeeded');
    assert.equal(f.bridge.steer(f.input).status, 'accepted', 'Retry after completion is still the same receipt');
    assert.throws(() => f.bridge.steer({ ...f.input, requestKey: 'late' }), { code: 'not_steerable' });
  } finally { f.clean(); }
});

test('steering does not mutate permissions, answer approval, reset deadline or accept override fields', () => {
  const f = fixture();
  try {
    f.activate();
    const permission = f.bridge.store.requestPermission(f.run.id, 'owner', 'Bash', { command: 'test' }, 'Approve');
    const before = f.bridge.store.getRun(f.run.id);
    assert.throws(() => f.bridge.steer({ ...f.input, model: 'other' } as any));
    f.bridge.steer(f.input);
    assert.equal(f.bridge.store.getPermission(permission.id).decision, 'pending');
    assert.deepEqual(f.bridge.store.getRun(f.run.id), before);
    const old = process.env.AGENT_BRIDGE_DELEGATION_DEPTH;
    try { process.env.AGENT_BRIDGE_DELEGATION_DEPTH = '1'; assert.throws(() => f.bridge.steer(f.input), { code: 'delegation_loop' }); }
    finally { if (old === undefined) delete process.env.AGENT_BRIDGE_DELEGATION_DEPTH; else process.env.AGENT_BRIDGE_DELEGATION_DEPTH = old; }
  } finally { f.clean(); }
});

for (const ending of ['completion', 'cancel', 'lost-worker'] as const) test(`${ending} closes admission and never replays uncertain steering`, () => {
  const f = fixture();
  try {
    f.activate();
    const sent = f.bridge.steer(f.input);
    f.bridge.store.claimSteering(f.run.id, 'owner');
    const pending = f.bridge.steer({ ...f.input, requestKey: 'second' });
    if (ending === 'cancel') f.bridge.store.requestCancel(f.run.id);
    if (ending === 'lost-worker') f.bridge.store.reconcile(Date.now() + 1000, () => false);
    else f.bridge.store.finishRun(f.run.id, 'owner', ending === 'cancel' ? 'cancelled' : 'succeeded');
    assert.equal(f.bridge.store.getSteering(sent.id).status, 'unknown');
    assert.equal(f.bridge.store.getSteering(pending.id).status, 'rejected');
    assert.equal(f.bridge.store.claimSteering(f.run.id, 'owner'), null);
    assert.equal(f.bridge.steer(f.input).id, sent.id);
    assert.equal(f.bridge.store.getRun(f.run.id).steeringOpen, false);
    f.bridge.store.prune(Date.now() + 1000);
    assert.equal(f.bridge.store.getSteering(sent.id).prompt, '[pruned]');
    assert.equal(f.bridge.steer(f.input).status, 'unknown');
    assert.equal(f.bridge.transcript(f.run.id).events.length, 0);
  } finally { f.clean(); }
});

test('v6 migration leaves pre-upgrade workers unsteerable and preserves runs', () => {
  const f = fixture(); f.activate(); f.bridge.close();
  const db = new DatabaseSync(join(f.settings.stateDir, 'bridge.sqlite'));
  db.exec('DROP TABLE steering_requests; ALTER TABLE runs DROP COLUMN steering_open; PRAGMA user_version=6'); db.close();
  const migrated = new Bridge(f.settings, () => {});
  try {
    assert.equal(migrated.store.getRun(f.run.id).steeringOpen, false);
    assert.throws(() => migrated.steer(f.input), { code: 'not_steerable' });
    migrated.store.openSteering(f.run.id, 'owner');
    assert.equal(migrated.steer(f.input).status, 'pending');
  } finally { migrated.close(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const scenario of ['folded', 'next-turn', 'uncorrelated'] as const) test(`Claude priority steering tracks actual result correlation: ${scenario}`, async () => {
  const f = fixture();
  f.bridge.store.attachWorker(f.run.id, 'owner', process.pid); f.bridge.store.claimRun(f.run.id, 'owner');
  const abort = new AbortController();
  const received: any[] = [];
  const open = ((input: Parameters<typeof query>[0]) => ({
    initializationResult: async () => ({}), setPermissionMode: async () => {},
    reinitialize: async () => ({ current_permission_mode: 'default', hooks_applied: true }), close() {},
    async *[Symbol.asyncIterator]() {
      assert.notEqual(typeof input.prompt, 'string');
      const incoming = (input.prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
      const original = (await incoming.next()).value;
      yield { type: 'system', subtype: 'init', session_id: f.conversation.id, permissionMode: 'default' };
      received.push((await incoming.next()).value);
      received.push((await incoming.next()).value);
      const result = { type: 'result', subtype: 'success', session_id: f.conversation.id, is_error: false, result: 'Steered answer', total_cost_usd: 0.2, usage: { input_tokens: 20 } };
      if (scenario === 'next-turn') {
        yield { ...result, result: 'Original answer', total_cost_usd: 0.1, usage: { input_tokens: 10 }, user_message_uuid: original.uuid };
        assert.equal(f.bridge.store.getRun(f.run.id).steeringOpen, true);
      }
      yield { ...result, ...(scenario === 'uncorrelated' ? {} : { user_message_uuids: [original.uuid, ...received.map(m => m.uuid)] }) };
      if (scenario !== 'uncorrelated') assert.equal((await incoming.next()).done, true);
    },
  })) as unknown as typeof query;
  const work = runClaude(f.settings, f.bridge.store, f.run, f.conversation, 'owner', abort, open);
  void work.catch(() => {});
  try {
    await until(() => Boolean(f.bridge.store.getRun(f.run.id).steeringOpen));
    const first = f.bridge.steer(f.input);
    const second = f.bridge.steer({ ...f.input, requestKey: 'second', prompt: '/compact is literal text, not a command' });
    if (scenario === 'uncorrelated') await assert.rejects(work, { code: 'unknown_outcome' });
    else {
      assert.equal((await work as any).result, 'Steered answer');
      assert.equal(f.bridge.store.getSteering(first.id).status, 'accepted');
      assert.equal(f.bridge.store.getSteering(second.id).status, 'accepted');
      assert.equal(f.bridge.store.getRun(f.run.id).usage?.cumulative.estimatedCostUsd, 0.2, 'Never sum cumulative native results');
      assert.equal(f.bridge.store.getRun(f.run.id).usage?.turn?.tokens.input, 20, 'Turn usage describes the latest native turn');
    }
    assert.equal(received.length, 2);
    assert.ok(received.every(m => m.priority === 'now' && m.client_composed === true));
    assert.equal(received[0].message.content, f.input.prompt);
    assert.equal(f.bridge.store.getRun(f.run.id).steeringOpen, false);
  } finally { abort.abort(); await work.catch(() => {}); f.clean(); }
});
