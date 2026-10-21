import { workerAlive, processIdentity } from './process-identity.js';
import { effectiveStopReason } from './run-diagnostics.js';
import { TERMINAL, type Run, type Event } from './types.js';

export function recovery(run: Run, workerProbe: typeof workerAlive = workerAlive, processProbe: typeof processIdentity = processIdentity, activeRunIds: string[] = []) {
  const terminal = TERMINAL.includes(run.status), d = run.diagnostics;
  const neverStarted = run.startedAt === null && run.workerPid === null;
  const alive = neverStarted ? false : !terminal ? true : workerProbe(run);
  const worker = neverStarted ? 'not_started' : alive === true ? 'running' : alive === false ? 'exited' : 'unverified';
  let runtime = d?.runtime?.state ?? (neverStarted ? 'not_started' : 'unverified');
  if (terminal && runtime !== 'exited' && runtime !== 'not_started' && d?.runtime?.pid) {
    const observed = processProbe(d.runtime.pid);
    // Compare process start identity, never PID alone. Absence is also definitive.
    if (observed === null || (typeof observed === 'string' && d.runtime.identity && observed !== d.runtime.identity)) runtime = 'exited';
    else runtime = typeof observed === 'string' && observed === d.runtime.identity ? 'running' : 'unverified';
  }
  const quiescent = ['exited', 'not_started'].includes(worker) && ['exited', 'not_started'].includes(runtime);
  const reason = effectiveStopReason(run);
  const transcript = d?.transcript ?? (neverStarted ? 'not_started' : 'unverified');
  const contextKnown = d?.dispatch === 'not_sent' || neverStarted || (d?.shutdown === 'clean' && transcript === 'runtime_reported');
  let nextAction: 'wait' | 'inspect' | 'retry_when_available' | 'continue' = 'inspect';
  if (activeRunIds.length || !terminal || worker === 'running' || runtime === 'running') nextAction = 'wait';
  else if (quiescent && contextKnown && run.status !== 'unknown') nextAction = ['allowance_exhausted', 'throttled', 'capacity'].includes(reason ?? '') ? 'retry_when_available' : 'continue';
  return { stopReason: reason, nativeCode: d?.nativeCode ?? null, worker, runtime,
    shutdown: d?.shutdown ?? 'unverified', transcript, observedAt: Date.now(),
    ownedProcessesStopped: quiescent, readyForFollowUp: nextAction === 'continue',
    readyForHandoff: terminal && quiescent && activeRunIds.length === 0, activeRunIds, nextAction,
    explanation: nextAction === 'wait' ? 'Wait for the current work and owned processes to stop.' : nextAction === 'inspect' ? 'Inspect the saved session, workspace and side effects before continuing. Do not automatically replay the prompt.' : nextAction === 'retry_when_available' ? 'Owned processes stopped; wait for provider availability, then send a deliberate follow-up.' : 'Owned processes stopped; a deliberate follow-up is possible. This is not a correctness check of the work.',
  };
}
const text = (value: unknown, max = 500) => typeof value === 'string' ? value.slice(0, max) : null;
export function summarizeEvents(events: Event[]) {
  return events.map(event => {
    const d = event.data as any;
    const category = event.type === 'text' ? 'agent_report' : event.type === 'tool' ? (d?.tool === 'commandExecution' ? 'command_result' : 'activity') : event.type === 'command_result' ? 'command_result' : event.type === 'result' ? 'runtime_result' : event.type === 'warning' ? 'warning' : event.type;
    return { seq: event.seq, evidence: { runId: event.runId, afterSeq: Math.max(0, event.seq - 1), throughSeq: event.seq }, at: event.at, category,
      text: text(d?.text ?? d?.message ?? d?.reason),
      ...(d?.tool ? { tool: text(d.tool, 120) } : {}),
      ...(typeof d?.command === 'string' ? { command: text(d.command, 400), exitCode: Number.isInteger(d.exitCode) ? d.exitCode : null } : {}),
      ...(typeof d?.isError === 'boolean' ? { isError: d.isError } : {}),
      ...(typeof d?.status === 'string' ? { status: text(d.status, 100) } : {}) };
  });
}
