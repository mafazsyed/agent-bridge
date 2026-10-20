// node:sqlite reports errcode; some runtime versions expose the symbolic code instead.
export function sqliteBusy(error: unknown): boolean {
  const e = error as { errcode?: unknown; code?: unknown } | null;
  return !!e && ((typeof e.errcode === 'number' && [5, 6].includes(e.errcode & 255)) ||
    e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED');
}
export function tolerateBusy(error: unknown, lastHeartbeat: number, staleMs: number, now = Date.now()): boolean {
  return sqliteBusy(error) && now - lastHeartbeat < staleMs;
}
export const queueDelay = () => 500 + Math.floor(Math.random() * 1000);
