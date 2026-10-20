import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { claudeUsage, codexUsage, saveUsage } from '../src/usage.js';
import { claudeLimits, codexLimits, discoverAccountLimits, createLimitsDiscovery } from '../src/limits.js';
import { CodexRpcError } from '../src/codex-client.js';
import { Bridge, workerEnv } from '../src/service.js';
import { parseConcurrency } from '../src/config.js';
import { tolerateBusy } from '../src/contention.js';

const settings = { stateDir: 'unused', executable: 'fixture', codexExecutable: 'fixture', maxActive: 1, staleMs: 120_000 };
const value = {
  total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 30, cache_creation_input_tokens: 20 },
  modelUsage: { 'test-model': { inputTokens: 50, outputTokens: 9, cacheReadInputTokens: 300, cacheCreationInputTokens: 200,
    thinkingTokens: 3, costUSD: 0.12, costBasis: 'managed', secret: 'PRIVATE' } }, secret: 'PRIVATE',
};
test('Claude usage distinguishes main-loop turn from cumulative estimates and never adds snapshots', () => {
  const first = claudeUsage(value, '2.1.302'), followup = claudeUsage({ ...value, total_cost_usd: 0.2 }, '2.1.302');
  assert.equal(first.turn?.tokens.input, 10);
  assert.equal(first.turn?.tokens.total, null);
  assert.equal(first.cumulative.models?.[0]?.tokens.input, 50);
  assert.equal(first.cumulative.models?.[0]?.costBasis, 'managed');
  assert.equal(followup.cumulative.estimatedCostUsd, 0.2);
  assert.equal(followup.cumulative.scope, 'session');
  assert.equal(claudeUsage(value, '2.1.276').cumulative.scope, 'query');
  assert.equal(claudeUsage(value).cumulative.scope, 'runtime-reported');
  assert.equal(JSON.stringify(first).includes('PRIVATE'), false);
});
test('missing or invalid usage is not zero, and zeroed error results cannot erase trustworthy spend', () => {
  const missing = claudeUsage({});
  assert.equal(missing.status, 'unavailable'); assert.equal(missing.cumulative.estimatedCostUsd, null);
  const failed = claudeUsage({ is_error: true, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 });
  assert.equal(failed.reason, 'zeroed_error_result'); assert.equal(failed.turn, null); assert.equal(failed.cumulative.estimatedCostUsd, null);
  const partial = claudeUsage({ ...value, is_error: true });
  assert.equal(partial.status, 'partial'); assert.equal(partial.cumulative.estimatedCostUsd, 0.12);
  const malformed = claudeUsage({ usage: { input_tokens: -1, output_tokens: Infinity, cache_read_input_tokens: '20' }, total_cost_usd: NaN });
  assert.equal(malformed.turn?.tokens.input, null); assert.equal(malformed.turn?.tokens.output, null);
  assert.equal(malformed.turn?.tokens.cacheRead, null);
  assert.equal(claudeUsage({ usage: { input_tokens: 0 }, total_cost_usd: 0 }).cumulative.estimatedCostUsd, 0);
});
test('Codex totals and last snapshot are preserved without fabricating per-turn cost or tokens', () => {
  const snapshot = codexUsage({ total: { inputTokens: 80, cachedInputTokens: 30, outputTokens: 20, reasoningOutputTokens: 10, totalTokens: 100 },
    last: { inputTokens: 50, outputTokens: 10 }, modelContextWindow: 200000 });
  assert.equal(snapshot?.cumulative.tokens?.total, 100); assert.equal(snapshot?.lastReported?.input, 50);
  assert.equal(snapshot?.turn, null); assert.equal(snapshot?.cumulative.estimatedCostUsd, null);
  assert.equal(snapshot?.lastReported?.cacheWrite, null); assert.equal(codexUsage({}), null);
});
test('account normalization preserves nulls, authoritative denial and bucket identity without disclosing private fields', () => {
  const legacy = { limitId: 'one', primary: { usedPercent: 0, resetsAt: 1790000000, windowDurationMins: 300 } };
  const snapshot = codexLimits({ accountId: 'PRIVATE', ordinaryUsageAllowed: false, rateLimits: legacy,
    rateLimitsByLimitId: { one: { ...legacy, spendControlReached: true, credits: { hasCredits: true, unlimited: false, balance: 'PRIVATE' } }, two: { secondary: null } },
    rateLimitResetCredits: { availableCount: 2, credits: [{ id: 'PRIVATE' }] } });
  assert.equal(snapshot.buckets.length, 2); assert.equal(snapshot.ordinaryUsageAllowed, false);
  assert.equal(snapshot.buckets[0]?.spendControlReached, true);
  assert.equal(snapshot.buckets[0]?.windows[0]?.window?.resetsAt, new Date(1790000000000).toISOString());
  assert.equal(snapshot.buckets[1]?.windows[0]?.window, null);
  assert.equal(snapshot.availableResetCredits, 2); assert.equal(JSON.stringify(snapshot).includes('PRIVATE'), false);
  assert.equal(codexLimits({ rateLimits: legacy, rateLimitsByLimitId: null }).buckets.length, 1);
  assert.equal(codexLimits({ rateLimits: legacy, rateLimitsByLimitId: {} }).buckets.length, 1);
  assert.equal(codexLimits({ rateLimits: null }).status, 'unavailable');
  assert.equal(codexLimits({ rateLimits: { primary: null, secondary: {} } }).status, 'unavailable');
  assert.equal(codexLimits({ rateLimits: {}, ordinaryUsageAllowed: false }).status, 'available');
  assert.equal(claudeLimits({ rate_limits_available: true, rate_limits: {} }).status, 'unavailable');
  assert.equal(claudeLimits({ rate_limits_available: true, rate_limits: { five_hour: null } }).status, 'unavailable');
  const claude = claudeLimits({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: null, resets_at: '2026-10-20T10:00:00Z' },
    model_scoped: [{ display_name: 'Opus', utilization: 12, resets_at: null }], extra_usage: { is_enabled: true, monthly_limit: 'PRIVATE', used_credits: 'PRIVATE', utilization: 5 },
  }, behaviors: { secrets: 'PRIVATE' }, session: { secrets: 'PRIVATE' } });
  assert.equal(claude.buckets[0]?.windows[0]?.window?.usedPercent, null);
  assert.equal(claude.buckets[1]?.name, 'Opus'); assert.equal(JSON.stringify(claude).includes('PRIVATE'), false);
  assert.equal(claudeLimits({ rate_limits_available: false, rate_limits: null }).status, 'unavailable');
  assert.throws(() => claudeLimits({}), { code: 'limits_protocol' });
  assert.throws(() => codexLimits({}), { code: 'limits_protocol' });
});
test('Claude account probe has no inference input, tools, persistence or behavioral scan', async () => {
  let input: any, closed = false;
  const snapshot = await discoverAccountLimits(settings, 'claude', { openClaude: x => {
    input = x;
    return { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async opts => {
      assert.deepEqual(opts, { skipBehaviors: true });
      return { rate_limits_available: false, rate_limits: null } as any;
    }, close: () => { closed = true; } };
  } });
  assert.equal(snapshot.status, 'unavailable'); assert.equal(closed, true);
  assert.deepEqual(input.options.tools, []); assert.equal(input.options.persistSession, false);
  assert.equal((await input.options.canUseTool()).behavior, 'deny');
  const messages = []; for await (const item of input.prompt) messages.push(item);
  assert.deepEqual(messages, []);
  assert.equal(input.options.abortController.signal.aborted, true);
});
test('limits probes distinguish unsupported, auth failure and timeout, and always close', async () => {
  const absent = await discoverAccountLimits(settings, 'claude', { openClaude: () => ({ close() {} } as any) });
  assert.equal(absent.status, 'unsupported');
  let closed = 0;
  const codex = (error: Error) => ({ initialize: async () => ({}), request: async () => { throw error; }, close: async () => { closed++; } });
  assert.equal((await discoverAccountLimits(settings, 'codex', { openCodex: () => codex(new CodexRpcError(-32601, 'Localized message')) })).status, 'unsupported');
  await assert.rejects(discoverAccountLimits(settings, 'codex', { openCodex: () => codex(new CodexRpcError(401, 'authentication required SECRET')) }), e => (e as any).code === 'auth_required' && !String(e).includes('SECRET'));
  await assert.rejects(discoverAccountLimits(settings, 'codex', { openCodex: () => codex(new Error('PRIVATE raw error')) }), e => (e as any).code === 'limits_failed' && !String(e).includes('PRIVATE'));
  await assert.rejects(discoverAccountLimits(settings, 'codex', { timeoutMs: 10, openCodex: () => ({
    initialize: () => new Promise(() => {}), request: async () => ({}), close: async () => { closed++; },
  }) }), { code: 'limits_timeout' });
  await assert.rejects(discoverAccountLimits(settings, 'claude', { timeoutMs: 10, openClaude: () => ({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}), close: () => { closed++; },
  }) }), { code: 'limits_timeout' });
  assert.equal(closed, 5);
});
test('account reads coalesce only pending requests, never return stale data after account changes', async () => {
  let calls = 0, release!: (x: any) => void;
  const read = createLimitsDiscovery(settings, async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  const a = read('claude'), b = read('claude');
  assert.equal(a, b); assert.equal(calls, 1);
  release(claudeLimits({ rate_limits_available: false })); await a;
  const c = read('claude'); assert.equal(calls, 2);
  release(claudeLimits({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 20 } } }));
  assert.equal((await c).status, 'available');
});
test('usage survives reopen/prune, old v3 rows migrate to unknown, and stale workers cannot replace it', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-usage-')));
  let bridge = new Bridge({ ...settings, stateDir: root }, () => {});
  try {
    const start = bridge.start({ requestKey: 'usage', cwd: root, prompt: 'Test' });
    bridge.close();
    const db = new DatabaseSync(join(root, 'bridge.sqlite'));
    db.exec('ALTER TABLE runs DROP COLUMN usage_json; PRAGMA user_version = 3'); db.close();
    bridge = new Bridge({ ...settings, stateDir: root }, () => {});
    assert.equal(bridge.get(start.run.id).run.usage, null);
    bridge.store.attachWorker(start.run.id, 'token', process.pid); bridge.store.claimRun(start.run.id, 'token');
    const usage = claudeUsage(value, '2.1.302');
    assert.equal(bridge.store.recordUsage(start.run.id, 'wrong', usage), false);
    assert.equal(bridge.store.recordUsage(start.run.id, 'token', usage), true);
    bridge.store.finishRun(start.run.id, 'token', 'unknown', 'answer retained');
    assert.equal(bridge.store.recordUsage(start.run.id, 'token', claudeUsage({})), false);
    bridge.store.prune(Date.now() + 1000);
    bridge.close(); bridge = new Bridge({ ...settings, stateDir: root }, () => {});
    assert.deepEqual(bridge.get(start.run.id).run.usage, usage);
  } finally { bridge.close(); rmSync(root, { recursive: true, force: true }); }
});
test('unlimited worker configuration round trips as a string; brief SQLite contention is not lease loss', () => {
  const env = workerEnv({ ...settings, maxActive: 'unlimited' }, {});
  assert.equal(env.AGENT_BRIDGE_MAX_ACTIVE, 'unlimited');
  assert.equal(parseConcurrency(env.AGENT_BRIDGE_MAX_ACTIVE), 'unlimited');
  assert.equal(parseConcurrency(' Unlimited '), 'unlimited'); assert.equal(parseConcurrency('100'), 100);
  for (const bad of ['1e3', '0x10']) assert.throws(() => parseConcurrency(bad), { code: 'invalid_config' });
  assert.equal(tolerateBusy({ code: 'ERR_SQLITE_ERROR', errcode: 5 }, 100, 1000, 200), true);
  assert.equal(tolerateBusy({ errcode: 5 }, 100, 1000, 1100), false);
  assert.equal(tolerateBusy({ errcode: 10 }, 100, 1000, 200), false);
});
test('a busy telemetry write leaves the run active and can be retried after the lock is released', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-usage-busy-')));
  const bridge = new Bridge({ ...settings, stateDir: root }, () => {});
  const db = new DatabaseSync(join(root, 'bridge.sqlite'));
  try {
    const started = bridge.start({ requestKey: 'busy', cwd: root, prompt: 'Test' });
    bridge.store.attachWorker(started.run.id, 'token', process.pid); bridge.store.claimRun(started.run.id, 'token');
    db.exec('BEGIN IMMEDIATE');
    assert.equal(saveUsage(bridge.store, started.run.id, 'token', claudeUsage(value)), false);
    db.exec('ROLLBACK');
    assert.equal(bridge.get(started.run.id).run.status, 'running');
    assert.equal(bridge.get(started.run.id).run.usage, null);
    assert.equal(bridge.store.recordUsage(started.run.id, 'token', claudeUsage(value)), true);
  } finally { db.close(); bridge.close(); rmSync(root, { recursive: true, force: true }); }
});
