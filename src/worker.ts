import { setTimeout as delay } from 'node:timers/promises';
import { config } from './config.js';
import { Store } from './store.js';
import { BridgeError, TERMINAL } from './types.js';
import { runClaude, errorCode, resultErrorCode } from './runtime.js';
import { runCodex } from './codex-runtime.js';
import { prepareWorktree, snapshotFork } from './git.js';
import { processIdentity, workerAlive } from './process-identity.js';
import { appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tolerateBusy, queueDelay } from './contention.js';

async function main() {
  const [, , stateDir, runId, token] = process.argv;
  if (!stateDir || !runId || !token) throw new Error('Worker requires state directory, run ID and owner token');
  const store = new Store(stateDir);
  const abort = new AbortController();
  let reason: 'cancelled' | 'timeout' | 'lease_lost' | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let attached = false;
  let runtimeStarted = false;
  let abortAt: number | null = null;
  const stop = () => { reason = 'cancelled'; abort.abort(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    let identity = processIdentity(process.pid);
    for (let attempt = 0; !identity && attempt < 2; attempt++) { await delay(250); identity = processIdentity(process.pid); }
    if (!identity) throw new BridgeError('worker_identity_unavailable', 'Cannot establish a reliable process identity. No model turn started; retry when the machine is responsive.');
    attached = store.attachWorker(runId, token, process.pid, identity);
    if (!attached) return;
    const settings = { ...config(false), stateDir };
    let lastHeartbeat = Date.now(), lastReconcile = 0;
    while (true) {
      try {
        if (store.claimRun(runId, token, settings.maxActive)) { lastHeartbeat = Date.now(); break; }
        const current = store.getRun(runId);
        if (TERMINAL.includes(current.status)) return;
        if (current.cancelRequested || abort.signal.aborted) { store.finishRun(runId, token, 'cancelled', null, 'cancelled'); return; }
        if (!store.heartbeat(runId, token)) return;
        lastHeartbeat = Date.now();
        if (Date.now() - lastReconcile > 10_000) { store.reconcile(Date.now() - settings.staleMs, workerAlive); lastReconcile = Date.now(); }
        if (Date.now() - current.createdAt > 24 * 60 * 60 * 1000) { store.finishRun(runId, token, 'failed', null, 'queue_timeout'); return; }
      } catch (error) { if (!tolerateBusy(error, lastHeartbeat, settings.staleMs)) throw error; }
      await delay(queueDelay());
    }
    const run = store.getRun(runId);
    let conversation = store.getConversation(run.conversationId);
    timer = setInterval(() => {
      try {
        if (reason) {
          abortAt ??= Date.now();
          abort.abort();
          if (Date.now() - abortAt >= 60_000) {
            store.finishRun(runId, token, 'unknown', 'Runtime did not settle within 60 seconds of abort. Inspect the session and any command side effects before continuing.', 'abort_timeout');
            process.exit(1);
          }
          return; // Never keep renewing a lease after abort.
        }
        if (!store.heartbeat(runId, token)) reason = 'lease_lost';
        else { lastHeartbeat = Date.now(); if (store.getRun(runId).cancelRequested) reason = 'cancelled'; }
        if (!reason && Date.now() - run.startedAt! > run.timeoutMs) reason = 'timeout';
        if (reason) abort.abort();
      } catch (error) { if (!tolerateBusy(error, lastHeartbeat, settings.staleMs)) { reason = 'lease_lost'; abort.abort(); } }
    }, 1000);
    if (conversation.fork && !conversation.sessionInitialized) {
      store.checkForkLease(runId, token);
      if (conversation.mode === 'write') conversation = store.recordForkSnapshot(runId, token, await snapshotFork(conversation, abort.signal));
    }
    await prepareWorktree(conversation, abort.signal);
    if (abort.signal.aborted || store.getRun(runId).cancelRequested) throw new BridgeError('cancelled', 'Run stopped during workspace preparation.');
    runtimeStarted = true;
    const result = conversation.runtime === 'codex' ? await runCodex(settings, store, run, conversation, token, abort) : await (async () => {
      const value = await runClaude(settings, store, run, conversation, token, abort);
      return { text: 'result' in value ? value.result : value.errors.join('\n'), success: !value.is_error, errorCode: resultErrorCode(value) };
    })();
    const text = result.text.slice(0, 1_000_000);
    // An explicit success is authoritative, even if cancellation raced its delivery.
    if (result.success) store.finishRun(runId, token, 'succeeded', text, null);
    else if (reason) store.finishRun(runId, token, reason === 'cancelled' ? 'cancelled' : 'unknown', text, reason);
    else store.finishRun(runId, token, 'failed', text, result.errorCode);
  } catch (error) {
    const code = error instanceof BridgeError ? error.code : errorCode(String(error));
    // Both runtimes use cancelled only before prompt dispatch. Native Claude
    // setup failures are also known unstarted work, even if the deadline raced.
    const knownUnstarted = !runtimeStarted || ['cancelled', 'permissions_unavailable', 'fork_source_missing', 'fork_unsupported', 'fork_setup_failed', 'fork_identity_invalid', 'fork_native_goal_unsupported'].includes(code);
    const status = reason === 'cancelled' || (code === 'cancelled' && !reason) ? 'cancelled' : (reason && !knownUnstarted) || ['unknown_outcome', 'session_identity_changed'].includes(code) ? 'unknown' : 'failed';
    const text = error instanceof BridgeError && error.completedResult !== undefined
      ? `[Completion could not be verified: ${String(error).slice(0, 8000)}]\n\n${error.completedResult}`.slice(0, 1_000_000)
      : String(error).slice(0, 8000);
    store.finishRun(runId, attached ? token : null, status, text, reason ?? code);
  } finally {
    if (timer) clearInterval(timer);
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    store.close();
  }
}
main().catch(error => {
  // Startup failures may precede a usable ledger. Keep diagnostics private, never on MCP stdout.
  const stateDir = process.argv[2];
  if (stateDir) {
    try {
      const file = join(stateDir, 'worker-errors.log');
      appendFileSync(file, `${new Date().toISOString()} ${process.argv[3]} ${String(error).slice(0, 2000)}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch { /* A subsequent reconcile marks the unstarted run failed. */ }
  }
  process.exitCode = 1;
});
