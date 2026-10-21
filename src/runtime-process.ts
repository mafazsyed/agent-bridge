import type { ChildProcess } from 'node:child_process';
import type { Store } from './store.js';
import { processIdentity } from './process-identity.js';

// Observe only the process we spawned. A kill request is never evidence of exit.
export function trackRuntime(child: ChildProcess, store: Store, runId: string, token: string) {
  let exited = false;
  const pid = child.pid ?? null;
  const identity = pid ? processIdentity(pid) ?? null : null;
  const record = (state: 'running' | 'exited' | 'not_started', exitCode?: number | null, signal?: string | null) => {
    try { store.recordDiagnostics(runId, token, { runtime: { pid, identity, state, observedAt: Date.now(), exitCode, signal } }); } catch { /* Missing evidence remains unknown; never invent success. */ }
  };
  record(pid ? 'running' : 'not_started');
  const done = new Promise<void>(resolve => {
    child.once('exit', (code, signal) => { exited = true; record('exited', code, signal); resolve(); });
    child.once('error', () => { if (!child.pid) { exited = true; record('not_started'); resolve(); } });
  });
  return async (timeoutMs = 3000) => {
    if (exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([done, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { clearTimeout(timer); }
    return exited;
  };
}
