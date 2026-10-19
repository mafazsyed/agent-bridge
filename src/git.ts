import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { BridgeError, type Conversation } from './types.js';

function git(cwd: string, args: string[], timeout = 30_000): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, windowsHide: true }).replace(/\r?\n$/, '');
}
export function resolveBase(cwd: string, ref: string): { repo: string; commit: string } {
  try {
    const repo = realpathSync.native(git(cwd, ['rev-parse', '--show-toplevel']));
    const commit = git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid object id');
    return { repo, commit };
  } catch { throw new BridgeError('invalid_repository', 'Write mode needs a Git repository and an existing baseRef (for example HEAD). Uncommitted source changes are not copied.'); }
}
export function prepareWorktree(conversation: Conversation): void {
  if (conversation.mode !== 'write') return;
  if (!conversation.branch || !conversation.baseCommit) throw new BridgeError('invalid_workspace', 'Missing worktree metadata');
  const receipt = `${conversation.cwd}.ready.json`;
  const expected = JSON.stringify({ id: conversation.id, branch: conversation.branch, baseCommit: conversation.baseCommit });
  if (existsSync(conversation.cwd)) {
    if (realpathSync.native(git(conversation.cwd, ['rev-parse', '--show-toplevel'])) !== realpathSync.native(conversation.cwd) || git(conversation.cwd, ['symbolic-ref', '--short', 'HEAD']) !== conversation.branch) {
      throw new BridgeError('workspace_conflict', 'Existing path is not the worktree assigned to this conversation.');
    }
    if (!existsSync(receipt) || readFileSync(receipt, 'utf8') !== expected) throw new BridgeError('workspace_incomplete', 'Worktree setup did not finish. Inspect this worktree before recovering it; no files will be reset automatically. Start a new conversation for a fresh worktree.');
    return;
  }
  mkdirSync(dirname(conversation.cwd), { recursive: true, mode: 0o700 });
  git(conversation.sourceCwd, ['worktree', 'add', '--no-checkout', '-b', conversation.branch, conversation.cwd, conversation.baseCommit]);
  // Disable repository hooks; checkout filters belong to the explicitly selected, trusted repository.
  git(conversation.cwd, ['reset', '--hard', conversation.baseCommit], 180_000);
  writeFileSync(`${receipt}.tmp`, expected, { mode: 0o600 });
  renameSync(`${receipt}.tmp`, receipt);
}
