// Allowlisted native telemetry only: never copy prompts, account identity or arbitrary payloads.
// Snapshots replace one another. Cumulative totals must never be summed across resumed runs.
export const record = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export const nonNegative = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export const count = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
export const label = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value.slice(0, 160) : null;

export interface Tokens {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  total: number | null;
}
export interface RunUsage {
  runtime: 'claude' | 'codex';
  observedAt: string;
  source: 'claude.result' | 'codex.thread/tokenUsage/updated';
  // reported means a native result was received, not that the whole run succeeded.
  status: 'partial' | 'reported' | 'unavailable';
  reason: 'zeroed_error_result' | 'error_result' | 'not_reported' | null;
  turn: { scope: 'main-agent-loop'; tokens: Tokens } | null;
  lastReported: Tokens | null;
  cumulative: {
    scope: 'session' | 'query' | 'runtime-reported';
    tokens: Tokens | null;
    estimatedCostUsd: number | null;
    models: { model: string; tokens: Tokens; estimatedCostUsd: number | null; costBasis: string | null }[] | null;
  };
  modelContextWindow: number | null;
}
export function saveUsage(store: { recordUsage(runId: string, token: string, usage: RunUsage): boolean }, runId: string, token: string, usage: RunUsage): boolean {
  // Accounting is optional. Never interrupt native shutdown/flush or reject a
  // successful turn because telemetry storage failed. Missing data stays unknown.
  try { return store.recordUsage(runId, token, usage); } catch { return false; }
}
const claudeTokens = (raw: unknown, camel = false): Tokens => {
  const v = record(raw);
  return {
    input: count(v[camel ? 'inputTokens' : 'input_tokens']),
    output: count(v[camel ? 'outputTokens' : 'output_tokens']),
    cacheRead: count(v[camel ? 'cacheReadInputTokens' : 'cache_read_input_tokens']),
    cacheWrite: count(v[camel ? 'cacheCreationInputTokens' : 'cache_creation_input_tokens']),
    reasoning: camel ? count(v.thinkingTokens) : null,
    total: null, // Claude input excludes cache tokens; do not invent a cross-runtime total.
  };
};
const codexTokens = (raw: unknown): Tokens => {
  const v = record(raw);
  return { input: count(v.inputTokens), output: count(v.outputTokens), cacheRead: count(v.cachedInputTokens),
    cacheWrite: count(v.cacheWriteInputTokens), reasoning: count(v.reasoningOutputTokens), total: count(v.totalTokens) };
};
export function claudeUsage(raw: unknown, version?: string): RunUsage {
  // Claude documents saved totals on SDK resume starting at 2.1.277:
  // https://code.claude.com/docs/en/agent-sdk/cost-tracking#accumulate-costs-across-multiple-calls
  const v = record(raw), parts = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
  const numbers = parts?.slice(1, 4).map(Number);
  const scope = !numbers ? 'runtime-reported' : numbers[0]! > 2 || (numbers[0] === 2 && (numbers[1]! > 1 || (numbers[1] === 1 && numbers[2]! >= 277))) ? 'session' : 'query';
  const result: RunUsage = {
    runtime: 'claude', source: 'claude.result', observedAt: new Date().toISOString(), status: v.is_error ? 'partial' : 'reported',
    reason: v.is_error ? 'error_result' : null,
    turn: Object.keys(record(v.usage)).length ? { scope: 'main-agent-loop', tokens: claudeTokens(v.usage) } : null,
    lastReported: null,
    cumulative: { scope, tokens: null, estimatedCostUsd: nonNegative(v.total_cost_usd),
      models: v.modelUsage == null ? null : Object.entries(record(v.modelUsage)).slice(0, 100).map(([model, rawModel]) => {
        const m = record(rawModel);
        return { model: model.slice(0, 160), tokens: claudeTokens(m, true), estimatedCostUsd: nonNegative(m.costUSD),
          costBasis: ['list', 'managed', 'unknown'].includes(m.costBasis) ? m.costBasis : null };
      }) },
    modelContextWindow: null,
  };
  const counters = [result.cumulative.estimatedCostUsd, ...Object.values(result.turn?.tokens ?? {}),
    ...(result.cumulative.models ?? []).flatMap(m => [m.estimatedCostUsd, ...Object.values(m.tokens)])];
  if (!counters.some(n => n !== null)) { result.status = 'unavailable'; result.reason = 'not_reported'; }
  else if (v.is_error && !counters.some(n => n !== null && n > 0)) {
    result.status = 'unavailable'; result.reason = 'zeroed_error_result';
    result.turn = null; result.cumulative.tokens = null; result.cumulative.estimatedCostUsd = null; result.cumulative.models = null;
  }
  return result;
}
export function codexUsage(raw: unknown): RunUsage | null {
  const v = record(raw);
  if (!Object.keys(record(v.total)).length && !Object.keys(record(v.last)).length) return null;
  return { runtime: 'codex', source: 'codex.thread/tokenUsage/updated', observedAt: new Date().toISOString(), status: 'partial', reason: null,
    turn: null, lastReported: Object.keys(record(v.last)).length ? codexTokens(v.last) : null,
    cumulative: { scope: 'session', tokens: Object.keys(record(v.total)).length ? codexTokens(v.total) : null, estimatedCostUsd: null, models: null },
    modelContextWindow: count(v.modelContextWindow) };
}
