import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateTool } from '../src/policy.js';

test('review has no execution or write capability and confines reads', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-policy-')));
  try {
    writeFileSync(join(root, 'source.txt'), 'fixture');
    assert.equal(evaluateTool(root, 'review', 'Read', { file_path: 'source.txt' }).kind, 'allow');
    for (const tool of ['Write', 'Edit', 'Bash', 'Agent', 'mcp__arbitrary']) assert.equal(evaluateTool(root, 'review', tool, { file_path: 'source.txt' }).kind, 'deny');
    assert.equal(evaluateTool(root, 'review', 'Read', { file_path: '../outside.txt' }).kind, 'deny');
    assert.equal(evaluateTool(root, 'review', 'Grep', { path: '/' }).kind, 'deny');
    assert.equal(evaluateTool(root, 'review', 'Glob', { pattern: '../**/*' }).kind, 'deny');
    assert.equal(evaluateTool(root, 'review', 'Glob', { pattern: '/etc/*' }).kind, 'deny');
    assert.equal(evaluateTool(root, 'review', 'Glob', { pattern: '{..,src}/**' }).kind, 'deny');
    assert.equal(evaluateTool(root, 'review', 'Glob', { pattern: '.{.,}/secret*' }).kind, 'deny');
    assert.equal(evaluateTool(root, 'review', 'Glob', { pattern: '{.,}{.,}/secret*' }).kind, 'deny');
    assert.equal(evaluateTool(root, 'review', 'Glob', { pattern: '**/*.{ts,tsx}' }).kind, 'allow');
    assert.equal(evaluateTool(root, 'review', 'AskUserQuestion', {}).kind, 'ask');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('write mode gates commands, protects metadata and checks physical paths', () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-write-')));
  const root = join(base, 'workspace');
  mkdirSync(root);
  mkdirSync(join(base, 'outside'));
  try {
    assert.equal(evaluateTool(root, 'write', 'Write', { file_path: 'new/nested/file.ts' }).kind, 'allow');
    assert.equal(evaluateTool(root, 'write', 'Bash', { command: 'npm test' }).kind, 'ask');
    assert.equal(evaluateTool(root, 'write', 'Bash', { command: 'npm test', run_in_background: true }).kind, 'deny');
    for (const name of ['.GIT', '.Claude', '.CoDeX', '.AGENTS', '.MCP.JSON', '.git. ', '.Claude ']) {
      assert.equal(evaluateTool(root, 'write', 'Write', { file_path: `${name}/config` }).kind, 'deny', name);
    }
    assert.equal(evaluateTool(root, 'write', 'Write', { file_path: '.git/config' }).kind, 'deny');
    assert.equal(evaluateTool(root, 'write', 'Edit', { file_path: '.claude/settings.json' }).kind, 'deny');
    symlinkSync(join(base, 'outside'), join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(evaluateTool(root, 'write', 'Write', { file_path: 'escape/new-file' }).kind, 'deny');
    assert.equal(evaluateTool(root, 'review', 'Read', { file_path: 'escape/new-file' }).kind, 'deny');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
