import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface WorkspaceCheckpoint {
  observedAt: number;
  cwd: string;
  status: 'observed' | 'unavailable';
  branch: string | null;
  commit: string | null;
  dirtyFiles: { status: string; path: string; from?: string }[];
  clean: boolean | null;
  truncated: boolean;
  error?: string;
}
export interface HandoffNote {
  recordedAt: number;
  source: 'host_reported';
  summary: string;
  unfinishedWork: string[];
  checks: { description: string; result: 'passed' | 'failed' | 'not_run' | 'unknown'; evidenceSeq?: number }[];
}
export async function captureWorkspace(cwd: string): Promise<WorkspaceCheckpoint> {
  const snapshot: WorkspaceCheckpoint = { observedAt: Date.now(), cwd, status: 'unavailable', branch: null, commit: null, dirtyFiles: [], clean: null, truncated: false };
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  const git = async (...args: string[]) => (await promisify(execFile)('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd, env, encoding: 'utf8', timeout: 5000, maxBuffer: 1_000_000, windowsHide: true })).stdout;
  try {
    // One porcelain snapshot contains branch, HEAD and NUL-delimited names, including renames.
    const records = (await git('status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all')).split('\0');
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      if (record.startsWith('# branch.oid ')) { const oid = record.slice(13); snapshot.commit = /^[a-f0-9]{40,64}$/.test(oid) ? oid : null; }
      else if (record.startsWith('# branch.head ')) { const branch = record.slice(14); snapshot.branch = branch === '(detached)' ? null : branch; }
      else if (/^[12u?] /.test(record)) {
        const type = record[0], fields = type === '1' ? 8 : type === '2' ? 9 : type === 'u' ? 10 : 1;
        let offset = 0;
        for (let j = 0; j < fields; j++) offset = record.indexOf(' ', offset) + 1;
        const from = type === '2' ? records[++i] : undefined;
        if (snapshot.dirtyFiles.length < 200) snapshot.dirtyFiles.push({ status: type === '?' ? '??' : record.slice(2, 4), path: record.slice(offset), ...(from === undefined ? {} : { from }) });
        else snapshot.truncated = true;
      } else if (record && !record.startsWith('# ')) throw new Error('Unexpected Git status record');
    }
    snapshot.status = 'observed'; snapshot.clean = !snapshot.truncated && snapshot.dirtyFiles.length === 0;
  } catch { snapshot.error = 'Git status unavailable or exceeded the bounded capture. No clean-worktree claim is made.'; }
  return snapshot;
}
