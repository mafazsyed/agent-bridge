import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Run } from './types.js';

export function workerAlive(run: Run): boolean | undefined {
  if (!run.workerPid) return false;
  const observed = processIdentity(run.workerPid);
  if (observed === null) return false;
  if (observed === undefined || !run.workerIdentity) return undefined;
  return observed === run.workerIdentity;
}

// PID alone is insufficient after reuse. Query only owned candidate workers, never signal them.
// null means absent; undefined means the probe was inconclusive, which must not fence a worker.
export function processIdentity(pid: number): string | null | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') return null;
      if (!fields[19]) return undefined;
      return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}`;
    }
    if (process.platform === 'win32') {
      const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$bridgeTargetProcess = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $bridgeTargetProcess) { 'absent' } else { $bridgeTargetProcess.StartTime.ToUniversalTime().Ticks }`], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return result === 'absent' ? null : result || undefined;
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch (error) {
    const e = error as { code?: string; status?: number };
    if (process.platform === 'linux' && e.code === 'ENOENT') return null;
    if (process.platform === 'darwin' && e.status === 1) return null;
    return undefined;
  }
}
