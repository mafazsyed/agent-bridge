import { execFileSync, execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { BridgeError, type Conversation } from './types.js';

const gitEnv = (overrides: NodeJS.ProcessEnv = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0', ...overrides });
const gitArgs = (args: string[]) => ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args];
async function gitAsync(cwd: string, args: string[], signal?: AbortSignal, env: NodeJS.ProcessEnv = {}) {
  const { stdout } = await promisify(execFile)('git', gitArgs(args), { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true, signal, env: gitEnv(env) });
  return stdout.replace(/\r?\n$/, '');
}
function git(cwd: string, args: string[], timeout = 30_000, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', gitArgs(args), { cwd, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, windowsHide: true,
    env: gitEnv(env), stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\r?\n$/, '');
}
// Scan NUL-delimited listings or discard quiet-command output. Keep diagnostics
// bounded even when Git emits one line-ending warning for every working file.
async function gitScan(cwd: string, args: string[], matches: ((entry: string) => boolean) | undefined, signal?: AbortSignal, env: NodeJS.ProcessEnv = {}): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs(args), { cwd, windowsHide: true, signal, timeout: 180_000, env: gitEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '', stderr = '', matched = false, failure: Error | undefined;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (!matches) return;
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf('\0')) !== -1) {
        matched ||= matches(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      if (pending.length > 1024 * 1024) { failure = new Error('Git returned an oversized listing entry'); child.kill(); }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', error => { failure = error; });
    child.on('close', (code, stoppedBy) => {
      if (failure) reject(failure);
      else if (code !== 0 || stoppedBy || pending) reject(new Error(`Git listing failed (${stoppedBy ?? code}): ${stderr}`));
      else resolve(matched);
    });
  });
}
export function resolveBase(cwd: string, ref: string): { repo: string; commit: string } {
  try {
    const repo = realpathSync.native(git(cwd, ['rev-parse', '--show-toplevel']));
    const commit = git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid object id');
    return { repo, commit };
  } catch { throw new BridgeError('invalid_repository', 'Write mode needs a Git repository and an existing baseRef (for example HEAD). Uncommitted source changes are not copied.'); }
}
export function forkBase(cwd: string, expectedCommit?: string, branch?: string | null): { repo: string; commit: string } {
  const base = resolveBase(cwd, 'HEAD');
  if (branch) {
    let current: string | undefined;
    try { current = git(cwd, ['symbolic-ref', '--short', 'HEAD']); } catch { /* A detached HEAD is not the assigned branch. */ }
    if (base.repo !== realpathSync.native(cwd) || current !== branch) throw new BridgeError('workspace_conflict', 'Fork source is not its assigned worktree and branch.');
  }
  if (expectedCommit && base.commit !== expectedCommit) throw new BridgeError('fork_source_changed', 'The source worktree HEAD changed before the fork was prepared. Start a new fork after inspecting it.');
  return base;
}
export async function snapshotFork(conversation: Conversation, signal?: AbortSignal): Promise<string> {
  if (!conversation.fork || !conversation.baseCommit) throw new BridgeError('invalid_workspace', 'Missing fork checkpoint.');
  forkBase(conversation.fork.cwd, conversation.baseCommit, conversation.fork.branch);
  const parent = dirname(conversation.cwd);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(parent, '.fork-index-'));
  const env = { GIT_INDEX_FILE: join(temp, 'index') };
  try {
    await gitAsync(conversation.fork.cwd, ['read-tree', conversation.baseCommit], signal, env);
    await gitScan(conversation.fork.cwd, ['add', '-A', '--', '.'], undefined, signal, env);
    if (await gitScan(conversation.fork.cwd, ['ls-files', '--stage', '-z'], entry => entry.startsWith('160000 '), signal, env)) {
      throw new BridgeError('fork_submodules_unsupported', 'The snapshot contains a submodule or embedded repository. Its working files cannot be copied by this fork.');
    }
    const tree = await gitAsync(conversation.fork.cwd, ['write-tree'], signal, env);
    if (await gitScan(conversation.fork.cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', conversation.fork.sourceBaseCommit ?? conversation.baseCommit, tree],
      p => p.split('/').some(part => ['.claude', '.codex', '.agents', '.mcp.json'].includes(part.toLowerCase().replace(/[ .]+$/, ''))), signal)) {
      throw new BridgeError('fork_source_agent_config_changed', 'Agent configuration changed since the source workspace was created. Review those changes and start a new conversation from an explicitly accepted base.');
    }
    forkBase(conversation.fork.cwd, conversation.baseCommit, conversation.fork.branch);
    return tree;
  } catch (error) {
    if (error instanceof BridgeError || signal?.aborted) throw error;
    throw new BridgeError('fork_source_unavailable', `Git could not snapshot the source workspace: ${String(error).slice(0, 2000)}`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
export async function prepareWorktree(conversation: Conversation, signal?: AbortSignal): Promise<void> {
  if (conversation.mode !== 'write') return;
  if (!conversation.branch || !conversation.baseCommit) throw new BridgeError('invalid_workspace', 'Missing worktree metadata');
  const receipt = `${conversation.cwd}.ready.json`;
  const expected = JSON.stringify({ id: conversation.id, branch: conversation.branch, baseCommit: conversation.baseCommit,
    ...(conversation.fork ? { snapshotTree: conversation.fork.snapshotTree ?? null } : {}) });
  if (existsSync(conversation.cwd)) {
    if (realpathSync.native(git(conversation.cwd, ['rev-parse', '--show-toplevel'])) !== realpathSync.native(conversation.cwd) || git(conversation.cwd, ['symbolic-ref', '--short', 'HEAD']) !== conversation.branch) {
      throw new BridgeError('workspace_conflict', 'Existing path is not the worktree assigned to this conversation.');
    }
    if (!existsSync(receipt) || readFileSync(receipt, 'utf8') !== expected) throw new BridgeError('workspace_incomplete', 'Worktree setup did not finish. Inspect this worktree before recovering it; no files will be reset automatically. Start a new conversation for a fresh worktree.');
    return;
  }
  mkdirSync(dirname(conversation.cwd), { recursive: true, mode: 0o700 });
  await gitAsync(conversation.sourceCwd, ['worktree', 'add', '--no-checkout', '-b', conversation.branch, conversation.cwd, conversation.baseCommit], signal);
  // Disable repository hooks; checkout filters belong to the explicitly selected, trusted repository.
  await gitAsync(conversation.cwd, ['reset', '--hard', '--quiet', conversation.baseCommit], signal);
  if (conversation.fork) {
    if (!conversation.fork.snapshotTree) throw new BridgeError('workspace_incomplete', 'Fork snapshot is missing; no history will be started.');
    await gitAsync(conversation.cwd, ['read-tree', '--reset', '-u', conversation.fork.snapshotTree], signal);
    // Keep the inherited edits visible as uncommitted work, without modifying the parent index.
    await gitAsync(conversation.cwd, ['reset', '--mixed', '--quiet', conversation.baseCommit], signal);
  }
  writeFileSync(`${receipt}.tmp`, expected, { mode: 0o600 });
  renameSync(`${receipt}.tmp`, receipt);
}
