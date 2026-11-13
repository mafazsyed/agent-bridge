import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Bridge, startSchema } from '../src/service.js';
import { validateWorkerScope, workerInstructions } from '../src/worker-scope.js';
import { evaluateTool } from '../src/policy.js';
import { prepareWorktree } from '../src/git.js';
import type { Conversation } from '../src/types.js';
const full = { runtime: 'codex', sandbox: 'danger-full-access', approvalPolicy: 'on-request', approvalsReviewer: 'user' } as const;
function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-host-scope-')));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  const settings = { stateDir: join(root, 'state'), executable: 'fixture', codexExecutable: 'fixture', maxActive: 'unlimited' as const, staleMs: 120_000 };
  const bridge = new Bridge(settings, () => {});
  return { root, settings, bridge, clean() { bridge.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('host requires compatible native controls, independently of full-access permissions', () => {
  assert.throws(() => validateWorkerScope('host', 'codex', 'review', full), { code: 'invalid_scope' });
  for (const sandbox of ['read-only', 'workspace-write'] as const) assert.throws(() => validateWorkerScope('host', 'codex', 'write', { ...full, sandbox }), { code: 'invalid_scope' });
  assert.throws(() => validateWorkerScope('host', 'codex', 'write', null), { code: 'invalid_scope' });
  assert.throws(() => validateWorkerScope('host', 'claude', 'write', { runtime: 'claude', permissionMode: 'plan' }), { code: 'invalid_scope' });
  validateWorkerScope('host', 'codex', 'write', full);
  for (const permissionMode of ['default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'] as const) validateWorkerScope('host', 'claude', 'write', { runtime: 'claude', permissionMode });
  validateWorkerScope('host', 'claude', 'write', null);
  validateWorkerScope('workspace', 'codex', 'write', full);
  assert.equal(startSchema.safeParse({ requestKey: 'x', prompt: 'x', scope: 'automatic' }).success, false);
});

test('scope persists, follows queued turns, is immutable, and rejects incompatible overrides before dispatch', () => {
  const f = setup();
  try {
    const input = { runtime: 'codex', requestKey: 'host', prompt: 'Authorized host task', cwd: f.root, mode: 'write', baseRef: 'HEAD', scope: 'host', permissions: full } as const;
    const first = f.bridge.start(input);
    assert.equal(first.conversation.scope, 'host');
    assert.equal(f.bridge.start(input).run.id, first.run.id);
    assert.equal(f.bridge.start({ requestKey: 'next', conversationId: first.conversation.id, prompt: 'Continue' }).conversation.scope, 'host');
    assert.throws(() => f.bridge.start({ ...input, scope: 'workspace' }), { code: 'idempotency_conflict' });
    assert.throws(() => f.bridge.start({ requestKey: 'narrow', conversationId: first.conversation.id, prompt: 'Continue', scope: 'workspace' }), { code: 'immutable_conversation' });
    assert.throws(() => f.bridge.start({ requestKey: 'incompatible', conversationId: first.conversation.id, prompt: 'Continue', permissions: { ...full, sandbox: 'workspace-write' } }), { code: 'invalid_scope' });
    const ordinary = f.bridge.start({ ...input, requestKey: 'ordinary', scope: undefined });
    assert.equal(ordinary.conversation.scope, 'workspace');
    assert.throws(() => f.bridge.start({ requestKey: 'widen', conversationId: ordinary.conversation.id, prompt: 'Continue', scope: 'host' }), { code: 'immutable_conversation' });
    assert.equal(f.bridge.store.listRuns().length, 3, 'Refused submissions leave no queued jobs');
    const reopened = new Bridge(f.settings, () => {});
    try { assert.equal(reopened.store.getConversation(first.conversation.id).scope, 'host'); } finally { reopened.close(); }
  } finally { f.clean(); }
});

test('legacy migration preserves old receipts and never infers host scope from full-access permissions', () => {
  const f = setup();
  const input = { runtime: 'codex', requestKey: 'old', prompt: 'x', cwd: f.root, mode: 'write', baseRef: 'HEAD', permissions: full } as const;
  const first = f.bridge.start(input); f.bridge.close();
  const db = new DatabaseSync(join(f.settings.stateDir, 'bridge.sqlite'));
  db.exec('ALTER TABLE conversations DROP COLUMN scope; PRAGMA user_version=7'); db.close();
  const migrated = new Bridge(f.settings, () => { throw new Error('must not redispatch'); });
  try {
    assert.equal(migrated.start(input).run.id, first.run.id);
    assert.equal(migrated.store.getConversation(first.conversation.id).scope, 'workspace');
    assert.throws(() => migrated.start({ requestKey: 'widen', conversationId: first.conversation.id, prompt: 'x', scope: 'host' }), { code: 'immutable_conversation' });
  } finally { migrated.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('forks inherit host scope and cannot combine it with a narrower permission override', async () => {
  const f = setup();
  try {
    const first = f.bridge.start({ runtime: 'codex', requestKey: 'source', prompt: 'x', cwd: f.root, mode: 'write', baseRef: 'HEAD', scope: 'host', permissions: full });
    await prepareWorktree(first.conversation);
    // The fixture only binds native history; it does not invoke a model or modify a real host.
    f.bridge.store.attachWorker(first.run.id, 'test', process.pid);
    f.bridge.store.claimRun(first.run.id, 'test', 'unlimited');
    f.bridge.store.bindNativeSession(first.run.id, 'test', 'native-fixture', 'fixture', 'high');
    f.bridge.store.finishRun(first.run.id, 'test', 'succeeded', 'done');
    assert.throws(() => f.bridge.fork({ sourceConversationId: first.conversation.id, requestKey: 'bad-fork', prompt: 'x', permissions: { ...full, sandbox: 'workspace-write' } }), { code: 'invalid_scope' });
    const fork = f.bridge.fork({ sourceConversationId: first.conversation.id, requestKey: 'fork', prompt: 'x' });
    assert.equal(fork.conversation.scope, 'host');
    assert.deepEqual(fork.run.permissions, full);
  } finally { f.clean(); }
});

for (const runtime of ['claude', 'codex'] as const) test(`${runtime} instructions distinguish host authorization from workspace full access, including forks`, () => {
  const c = { runtime, mode: 'write', cwd: '/workspace with spaces ', fork: { cwd: '/parent' } } as Conversation;
  const ordinary = workerInstructions(c);
  assert.match(ordinary, /Stay within the assigned workspace/); assert.match(ordinary, /Do not push/);
  assert.match(ordinary, /Do not read or modify that parent workspace/);
  const host = workerInstructions({ ...c, scope: 'host' });
  assert.match(host, /human owner has authorized work outside/); assert.match(host, /only as the human task describes/);
  assert.match(host, /pushes, merges, deployments and service management/);
  assert.doesNotMatch(host, /Stay within|Do not push|Do not read or modify that parent workspace/);
  assert.match(host, /Do not delegate or modify agent configuration/);
  assert.match(host, /"\/workspace with spaces "/);
});

test('host file hooks allow outside operations and background requests while retaining protected paths and tools', () => {
  const f = setup();
  try {
    const outside = join(f.root, 'outside'), workspace = join(f.root, 'workspace'); mkdirSync(outside); mkdirSync(workspace);
    symlinkSync(outside, join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const file_path of [join(outside, 'file'), '../outside/file', 'link/file']) {
      for (const tool of ['Read', 'Edit', 'Write']) {
        assert.equal(evaluateTool(workspace, 'write', tool, { file_path }, 'host').kind, 'allow');
        assert.equal(evaluateTool(workspace, 'write', tool, { file_path }).kind, 'deny');
      }
    }
    assert.equal(evaluateTool(workspace, 'write', 'Glob', { pattern: '../outside/*' }, 'host').kind, 'allow');
    assert.equal(evaluateTool(workspace, 'write', 'Grep', { path: outside }, 'host').kind, 'allow');
    assert.equal(evaluateTool(workspace, 'write', 'Bash', { command: 'service test restart', run_in_background: true }, 'host').kind, 'ask');
    for (const config of ['.git', '.codex', '.claude', '.agents', '.mcp.json']) {
      assert.equal(evaluateTool(workspace, 'write', 'Write', { file_path: join(outside, config, 'test') }, 'host').kind, 'deny');
    }
    mkdirSync(join(outside, '.codex'));
    symlinkSync(join(outside, '.codex'), join(workspace, 'config-link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(evaluateTool(workspace, 'write', 'Write', { file_path: 'config-link/config.toml' }, 'host').kind, 'deny');
    assert.equal(evaluateTool(workspace, 'write', 'Agent', {}, 'host').kind, 'deny');
  } finally { f.clean(); }
});
