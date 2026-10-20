import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';
import { BridgeError, type Runtime } from './types.js';
import { claudeOptions } from './claude-options.js';
import { CodexClient, CodexRpcError } from './codex-client.js';
import { record, nonNegative, count, label } from './usage.js';

interface Window { usedPercent: number | null; resetsAt: string | null; durationMinutes: number | null }
export interface AccountLimits {
  runtime: Runtime;
  source: 'claude-code' | 'codex';
  experimental: boolean;
  fetchedAt: string;
  status: 'available' | 'unavailable' | 'unsupported';
  scope: 'account';
  ordinaryUsageAllowed: boolean | null;
  // No account identity or credentials. These snapshots are returned, never persisted in the ledger.
  buckets: { id: string; name: string | null; windows: { id: string; window: Window | null }[];
    spendControlReached?: boolean | null; rateLimitReachedType?: string | null;
    credits?: { hasCredits: boolean | null; unlimited: boolean | null } | null }[];
  extraUsage: { enabled: boolean | null; utilization: number | null } | null;
  availableResetCredits: number | null;
  reason: string | null;
}
const bool = (v: unknown) => typeof v === 'boolean' ? v : null;
function iso(v: unknown, seconds = false): string | null {
  const n = seconds ? (typeof v === 'number' ? v * 1000 : NaN) : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= 8.64e15 ? new Date(n).toISOString() : null;
}
function window(raw: unknown, codex = false): Window | null {
  if (raw == null) return null;
  const v = record(raw);
  return { usedPercent: nonNegative(codex ? v.usedPercent : v.utilization),
    resetsAt: iso(codex ? v.resetsAt : v.resets_at, codex), durationMinutes: codex ? count(v.windowDurationMins) : null };
}
function empty(runtime: Runtime, status: AccountLimits['status'], reason: string | null = null): AccountLimits {
  return { runtime, source: runtime === 'claude' ? 'claude-code' : 'codex', experimental: runtime === 'claude',
    fetchedAt: new Date().toISOString(), scope: 'account', ordinaryUsageAllowed: null, status, buckets: [], extraUsage: null, availableResetCredits: null, reason };
}
function markAvailability(result: AccountLimits): AccountLimits {
  const information = result.ordinaryUsageAllowed !== null || result.availableResetCredits !== null ||
    result.buckets.some(b => b.spendControlReached != null || b.rateLimitReachedType != null ||
      b.credits?.hasCredits != null || b.credits?.unlimited != null ||
      b.windows.some(w => w.window?.usedPercent != null || w.window?.resetsAt != null));
  if (!information) { result.status = 'unavailable'; result.reason = 'The runtime returned no quota windows or access flags.'; }
  return result;
}
export function claudeLimits(raw: unknown): AccountLimits {
  const v = record(raw);
  if (typeof v.rate_limits_available !== 'boolean') throw new BridgeError('limits_protocol', 'Claude returned an unrecognized account-limits response.');
  if (!v.rate_limits_available || v.rate_limits == null) return empty('claude', 'unavailable', 'Claude did not provide plan limits for this authentication or account.');
  const limits = record(v.rate_limits), result = empty('claude', 'available');
  for (const id of ['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet']) {
    if (id in limits) result.buckets.push({ id, name: null, windows: [{ id, window: window(limits[id]) }] });
  }
  if (Array.isArray(limits.model_scoped)) for (const [index, m] of limits.model_scoped.slice(0, 100).entries()) {
    result.buckets.push({ id: `model_scoped:${index}`, name: label(m?.display_name), windows: [{ id: 'seven_day', window: window(m) }] });
  }
  if (limits.extra_usage != null) {
    const x = record(limits.extra_usage);
    result.extraUsage = { enabled: bool(x.is_enabled), utilization: nonNegative(x.utilization) };
  }
  return markAvailability(result);
}
export function codexLimits(raw: unknown): AccountLimits {
  const v = record(raw);
  if (!('rateLimits' in v) && !('rateLimitsByLimitId' in v)) throw new BridgeError('limits_protocol', 'Codex returned an unrecognized account-limits response.');
  const result = empty('codex', 'available');
  const map = Object.entries(record(v.rateLimitsByLimitId));
  const rows = map.length ? map : v.rateLimits != null ? [[label(v.rateLimits.limitId) ?? 'codex', v.rateLimits] as const] : [];
  for (const [id, rawBucket] of rows.slice(0, 100)) {
    const b = record(rawBucket), c = b.credits == null ? null : record(b.credits);
    result.buckets.push({ id: id.slice(0, 160), name: label(b.limitName),
      windows: ['primary', 'secondary'].map(id => ({ id, window: window(b[id], true) })),
      spendControlReached: bool(b.spendControlReached), rateLimitReachedType: label(b.rateLimitReachedType),
      credits: c && { hasCredits: bool(c.hasCredits), unlimited: bool(c.unlimited) } });
  }
  result.ordinaryUsageAllowed = bool(v.ordinaryUsageAllowed);
  result.availableResetCredits = count(record(v.rateLimitResetCredits).availableCount);
  return markAvailability(result);
}
type ClaudeProbe = Pick<Query, 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET' | 'close'>;
type OpenClaude = (input: Parameters<typeof query>[0]) => ClaudeProbe;
type CodexProbe = Pick<CodexClient, 'initialize' | 'request' | 'close'>;
export async function discoverAccountLimits(settings: Config, runtime: Runtime, options: {
  timeoutMs?: number; openClaude?: OpenClaude; openCodex?: (executable: string, cwd: string) => CodexProbe;
} = {}): Promise<AccountLimits> {
  const executable = runtime === 'claude' ? settings.executable : settings.codexExecutable;
  if (!executable) throw new BridgeError('cli_missing', `Install and sign in to ${runtime === 'claude' ? 'Claude Code' : 'Codex'} to read its account limits.`);
  const cwd = mkdtempSync(join(tmpdir(), 'agent-bridge-limits-'));
  const abort = new AbortController();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let claude: ClaudeProbe | undefined, codex: CodexProbe | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BridgeError('limits_timeout', `${runtime} account-limits request timed out. No inference was started.`)), options.timeoutMs ?? 20_000);
    });
    return await Promise.race([(async () => {
      if (runtime === 'claude') {
        claude = (options.openClaude ?? query)({ prompt: (async function* (): AsyncGenerator<SDKUserMessage> { await held; })(), options: {
          ...claudeOptions(settings), cwd, abortController: abort, tools: [], permissionMode: 'dontAsk', persistSession: false,
          canUseTool: async () => ({ behavior: 'deny', message: 'Account-limit discovery cannot execute tools.' }),
        } });
        const read = claude.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
        if (typeof read !== 'function') return empty(runtime, 'unsupported', 'This Claude SDK does not expose account limits.');
        return claudeLimits(await read.call(claude, { skipBehaviors: true }));
      }
      codex = (options.openCodex ?? ((exe, dir) => new CodexClient(exe, dir)))(executable, cwd);
      await codex.initialize();
      const account = await codex.request('account/read', { refreshToken: false });
      if (account?.requiresOpenaiAuth === true && !account.account) throw new BridgeError('auth_required', 'Codex is signed out. Run codex login.');
      if (account?.account?.type === 'apiKey' || account?.account?.type === 'apikey') return empty(runtime, 'unavailable', 'Codex plan limits are unavailable for API-key authentication.');
      return codexLimits(await codex.request('account/rateLimits/read', {}));
    })(), deadline]);
  } catch (error) {
    if (error instanceof CodexRpcError && error.rpcCode === -32601) return empty(runtime, 'unsupported', 'This Codex runtime does not expose account limits.');
    if (error instanceof BridgeError && ['limits_timeout', 'limits_protocol', 'auth_required', 'cli_missing'].includes(error.code)) throw error;
    // Native errors can contain configuration/account details. Return actionable categories, never raw payloads.
    const message = error instanceof Error ? error.message : '';
    if (runtime === 'claude' && /^(?:Unknown|Unsupported) control request(?: subtype)?:?\s*get_usage\b/i.test(message)) {
      return empty(runtime, 'unsupported', 'This Claude runtime does not expose account limits.');
    }
    if (/not authenticated|authentication (?:required|failed)|sign.?in required|log.?in required|unauthorized|oauth.*expired/i.test(message)) {
      throw new BridgeError('auth_required', `Sign in to ${runtime === 'claude' ? 'Claude Code' : 'Codex'} and retry account limits.`);
    }
    throw new BridgeError('limits_failed', `Unable to read ${runtime} account limits. Check the native CLI and account, then retry. No inference was started.`);
  } finally {
    clearTimeout(timer); release(); abort.abort();
    try { claude?.close(); } catch { /* Preserve the probe's result/error. */ }
    try { await codex?.close(); } catch { /* Preserve the probe's result/error. */ }
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}
// Coalesce only in-flight probes. Completed snapshots are not cached across account changes.
export function createLimitsDiscovery(settings: Config, discover = discoverAccountLimits) {
  const pending = new Map<Runtime, Promise<AccountLimits>>();
  return (runtime: Runtime) => {
    let result = pending.get(runtime);
    if (!result) {
      result = discover(settings, runtime).finally(() => { pending.delete(runtime); });
      pending.set(runtime, result);
    }
    return result;
  };
}
