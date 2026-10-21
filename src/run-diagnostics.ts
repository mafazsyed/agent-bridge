import type { Store } from './store.js';
import type { Run } from './types.js';

export type StopReason = 'completed' | 'allowance_exhausted' | 'throttled' | 'capacity' | 'turn_limit' | 'budget_limit' | 'cancelled' | 'timeout' | 'authentication' | 'runtime_failure' | 'uncertain';
export interface RuntimeProcessEvidence {
  pid: number | null;
  identity: string | null;
  state: 'running' | 'exited' | 'unverified' | 'not_started';
  observedAt: number;
  exitCode?: number | null;
  signal?: string | null;
}
export interface RunDiagnostics {
  dispatch?: 'sent' | 'not_sent';
  stopReason?: StopReason;
  nativeCode?: string | null;
  terminalResultAt?: number;
  shutdown?: 'pending' | 'clean' | 'unverified';
  transcript?: 'not_started' | 'runtime_reported' | 'unverified';
  runtime?: RuntimeProcessEvidence;
}
export function stopReason(code: string | null, success = false): StopReason {
  if (success) return 'completed';
  if (code === 'allowance_exhausted' || code === 'usageLimitExceeded' || code === 'sessionBudgetExceeded') return 'allowance_exhausted';
  if (code === 'rate_limited' || code === 'rateLimitExceeded') return 'throttled';
  if (code === 'capacity' || code === 'serverOverloaded') return 'capacity';
  if (code === 'error_max_turns') return 'turn_limit';
  if (code === 'error_max_budget_usd') return 'budget_limit';
  if (code === 'cancelled') return 'cancelled';
  if (code === 'timeout' || code === 'queue_timeout') return 'timeout';
  if (code === 'auth_required') return 'authentication';
  if (['unknown_outcome', 'worker_lost', 'abort_timeout', 'session_identity_changed', 'lease_lost'].includes(code ?? '')) return 'uncertain';
  return 'runtime_failure';
}
export function effectiveStopReason(run: Run): StopReason | null {
  return run.diagnostics?.stopReason ?? (run.status === 'succeeded' ? 'completed' : ['failed', 'cancelled', 'unknown'].includes(run.status) ? stopReason(run.errorCode ?? (run.status === 'unknown' ? 'unknown_outcome' : run.status)) : null);
}

// Reporting failure must not replace the native result or prevent owned-process cleanup.
// Absent evidence remains unverified in recovery().
export function saveDiagnostics(store: Store, runId: string, token: string, patch: RunDiagnostics): void {
  try { store.recordDiagnostics(runId, token, patch); } catch { /* Keep the primary outcome intact. */ }
}
