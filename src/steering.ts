import type { Store } from './store.js';
import type { SteeringRequest } from './types.js';

/** The owning worker alone dispatches input. A lost acknowledgement is never replayed. */
export function steeringPump(store: Store, runId: string, token: string, signal: AbortSignal,
  send: (request: SteeringRequest) => Promise<{ status: 'accepted' | 'rejected' | 'unknown'; errorCode?: string }>,
  failed: (error: Error) => void) {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    try { store.closeSteering(runId, token); }
    catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
  };
  const tick = () => {
    pending = (async () => {
      if (closed || signal.aborted) return;
      const request = store.claimSteering(runId, token);
      if (request) {
        const result = await send(request);
        store.settleSteering(request.id, token, result.status, result.errorCode ?? null);
      }
    })().catch(error => {
      close();
      failed(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => { if (!closed) timer = setTimeout(tick, 100); });
  };
  signal.addEventListener('abort', close, { once: true });
  return {
    open() {
      if (closed || signal.aborted || !store.openSteering(runId, token)) return;
      timer = setTimeout(tick, 0);
    },
    close,
    async drain() { close(); signal.removeEventListener('abort', close); await pending; },
  };
}
