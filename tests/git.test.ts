import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { prepareWorktree, resolveBase } from '../src/git.js';
import type { Conversation } from '../src/types.js';

test('implementation worktree preserves source including dirty files and trailing spaces', () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-git-')));
  const source = join(base, process.platform === 'win32' ? 'source with spaces' : 'source ');
  mkdirSync(source);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-b', 'main');
    writeFileSync(join(source, 'file.txt'), 'committed');
    git('add', 'file.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture');
    writeFileSync(join(source, 'file.txt'), 'user-uncommitted');
    const resolved = resolveBase(source, 'HEAD');
    assert.equal(resolved.repo, source);
    const c: Conversation = { id: randomUUID(), runtime: 'claude', nativeId: null, cwd: join(base, process.platform === 'win32' ? 'isolated with spaces' : 'isolated '), sourceCwd: source, mode: 'write', model: 'test', effort: 'high', baseCommit: resolved.commit, branch: 'agent-bridge/test', sessionInitialized: false, createdAt: 1 };
    prepareWorktree(c);
    assert.equal(readFileSync(join(c.cwd, 'file.txt'), 'utf8'), 'committed');
    writeFileSync(join(c.cwd, 'file.txt'), 'worker-edits');
    prepareWorktree(c); // Reopening must never reset ongoing work.
    assert.equal(readFileSync(join(c.cwd, 'file.txt'), 'utf8'), 'worker-edits');
    assert.equal(readFileSync(join(source, 'file.txt'), 'utf8'), 'user-uncommitted');
    assert.throws(() => prepareWorktree({ ...c, branch: 'wrong-branch' }), /worktree assigned/);
    rmSync(`${c.cwd}.ready.json`);
    assert.throws(() => prepareWorktree(c), /setup did not finish/);
    assert.equal(readFileSync(join(c.cwd, 'file.txt'), 'utf8'), 'worker-edits');
    const partial = { ...c, id: randomUUID(), cwd: join(base, 'partial'), branch: 'agent-bridge/partial' };
    git('worktree', 'add', '--no-checkout', '-b', partial.branch, partial.cwd, resolved.commit);
    assert.throws(() => prepareWorktree(partial), /setup did not finish/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
