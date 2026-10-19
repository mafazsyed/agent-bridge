import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Bridge } from '../src/service.js';
import { Store } from '../src/store.js';
import { CLAUDE_PERMISSION_MODES, runtimePermissionsSchema, validatePermissions, type RuntimePermissions } from '../src/permission-options.js';
import { claudePermissionPolicy, runClaude } from '../src/runtime.js';
import { discoverClaudePermissions, codexPermissionCatalogue } from '../src/permission-discovery.js';
import type { query, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-native-permissions-')));
  const settings = { stateDir: join(root, 'state'), executable: 'fixture', codexExecutable: 'fixture', maxActive: 1, staleMs: 120_000 };
  const bridge = new Bridge(settings, () => {});
  return { root, settings, bridge, clean() { bridge.close(); rmSync(root, { force: true, recursive: true }); } };
}
function git(root: string) {
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
}

test('native permissions persist defaults and snapshot each queued override without changing prior receipts', () => {
  const f = setup(); git(f.root);
  try {
    const first = f.bridge.start({ requestKey: 'first', prompt: 'plan', cwd: f.root, mode: 'write', baseRef: 'HEAD', permissions: { runtime: 'claude', permissionMode: 'plan' } });
    const second = f.bridge.start({ requestKey: 'second', prompt: 'edit', conversationId: first.conversation.id, permissions: { runtime: 'claude', permissionMode: 'acceptEdits' } });
    const third = f.bridge.start({ requestKey: 'third', prompt: 'plan again', conversationId: first.conversation.id });
    const fourth = f.bridge.start({ requestKey: 'fourth', prompt: 'controlled', conversationId: first.conversation.id, permissions: null });
    assert.equal(first.run.permissions?.runtime, 'claude');
    assert.deepEqual(second.run.permissions, { runtime: 'claude', permissionMode: 'acceptEdits' });
    assert.deepEqual(third.run.permissions, first.run.permissions);
    assert.equal(fourth.run.permissions, null);
    assert.deepEqual(f.bridge.store.getConversation(first.conversation.id).permissions, first.run.permissions);
    const reopened = new Store(f.settings.stateDir);
    assert.deepEqual(reopened.getRun(second.run.id).permissions, second.run.permissions); reopened.close();
    assert.throws(() => f.bridge.start({ requestKey: 'second', prompt: 'edit', conversationId: first.conversation.id, permissions: null }), { code: 'idempotency_conflict' });
    assert.throws(() => f.bridge.start({ requestKey: 'cross', prompt: 'x', conversationId: first.conversation.id, permissions: { runtime: 'codex', sandbox: 'workspace-write', approvalPolicy: 'never', approvalsReviewer: 'user' } }), { code: 'invalid_permissions' });
  } finally { f.clean(); }
});

test('v2 nullable migration preserves existing settings and idempotent replay', () => {
  const f = setup(); const input = { requestKey: 'old', prompt: 'review', cwd: f.root }; const first = f.bridge.start(input); f.bridge.close();
  const db = new DatabaseSync(join(f.settings.stateDir, 'bridge.sqlite'));
  db.exec('ALTER TABLE runs DROP COLUMN permissions_json; ALTER TABLE conversations DROP COLUMN permissions_json; PRAGMA user_version=2'); db.close();
  const migrated = new Bridge(f.settings, () => { throw new Error('must not dispatch twice'); });
  try { assert.equal(migrated.start(input).run.id, first.run.id); assert.equal(migrated.store.getRun(first.run.id).permissions, null); assert.equal(migrated.store.getConversation(first.conversation.id).permissions, null); }
  finally { migrated.close(); rmSync(f.root, { force: true, recursive: true }); }
});

test('runtime schemas reject cross keys, unknown aliases, incomplete granular policies and widening review', () => {
  assert.equal(runtimePermissionsSchema.safeParse({ runtime: 'claude', permissionMode: 'auto', sandbox: 'danger-full-access' }).success, false);
  assert.equal(runtimePermissionsSchema.safeParse({ runtime: 'codex', sandbox: 'workspace-write', approvalPolicy: 'on-failure', approvalsReviewer: 'user' }).success, false);
  assert.equal(runtimePermissionsSchema.safeParse({ runtime: 'codex', sandbox: 'workspace-write', approvalPolicy: { granular: { rules: true } }, approvalsReviewer: 'user' }).success, false);
  for (const permissionMode of ['acceptEdits', 'auto', 'bypassPermissions'] as const) assert.throws(() => validatePermissions({ runtime: 'claude', permissionMode }, 'claude', 'review'), { code: 'invalid_permissions' });
  for (const sandbox of ['workspace-write', 'danger-full-access'] as const) assert.throws(() => validatePermissions({ runtime: 'codex', sandbox, approvalPolicy: 'never', approvalsReviewer: 'user' }, 'codex', 'review'), { code: 'invalid_permissions' });
});

async function runFixture(permissions: RuntimePermissions | null, work: (options: Options, f: ReturnType<typeof setup>, runId: string) => Promise<void>, override: { applied?: string; initMode?: string; setError?: boolean; autoSupported?: boolean } = {}) {
  const f = setup();
  const submitted = f.bridge.start({ requestKey: randomUUID(), prompt: 'fixture', cwd: f.root });
  const run = { ...f.bridge.store.getRun(submitted.run.id), permissions };
  const conversation = { ...submitted.conversation, mode: 'write' as const };
  f.bridge.store.attachWorker(run.id, 'fixture', process.pid); f.bridge.store.claimRun(run.id, 'fixture');
  let received = false, closed = false, options!: Options;
  const selected = permissions?.runtime === 'claude' ? permissions.permissionMode : 'default';
  const open = ((input: Parameters<typeof query>[0]) => {
    options = input.options!;
    return {
      initializationResult: async () => ({}),
      supportedModels: async () => [{ value: run.model, supportsAutoMode: override.autoSupported ?? true }],
      setPermissionMode: async (mode: string) => { assert.equal(received, false); assert.equal(mode, selected); if (override.setError) throw new Error('organization denied'); },
      reinitialize: async () => ({ current_permission_mode: override.applied ?? selected }),
      close: () => { closed = true; },
      async *[Symbol.asyncIterator]() {
        if (typeof input.prompt !== 'string') { const p = await input.prompt[Symbol.asyncIterator]().next(); assert.equal(p.value.message.content, 'fixture'); }
        received = true;
        yield { type: 'system', subtype: 'init', session_id: conversation.id, model: 'fixture', permissionMode: override.initMode ?? selected };
        await work(options, f, run.id);
        yield { type: 'result', subtype: 'success', session_id: conversation.id, is_error: false, result: 'done' };
        if (permissions) await new Promise(() => {}); // A live streaming runtime waits for another turn.
      },
    };
  }) as unknown as typeof query;
  try { await runClaude(f.settings, f.bridge.store, run, conversation, 'fixture', new AbortController(), open); return { received, closed, options }; }
  catch (error) { Object.assign(error as Error, { received, closed }); throw error; }
  finally { f.clean(); }
}
async function hook(options: Options, tool: string, input: any, mode?: string) {
  const callback = options.hooks!.PreToolUse![0]!.hooks[0]!;
  return callback({ hook_event_name: 'PreToolUse', session_id: 'fixture', transcript_path: 'fixture', cwd: options.cwd!, tool_name: tool, tool_input: input, tool_use_id: 'fixture', ...(mode ? { permission_mode: mode } : {}) }, 'fixture', { signal: new AbortController().signal });
}
for (const permissionMode of CLAUDE_PERMISSION_MODES) test(`Claude native ${permissionMode}: pass-through decisions with enforced boundaries`, async () => {
  const result = await runFixture({ runtime: 'claude', permissionMode }, async (options, f) => {
    assert.equal(options.permissionMode, permissionMode);
    assert.equal(options.allowDangerouslySkipPermissions, permissionMode === 'bypassPermissions' ? true : undefined);
    assert.deepEqual(options.allowedTools, []);
    const edit = await hook(options, 'Write', { file_path: join(f.root, 'file.txt'), content: 'test' }, permissionMode);
    if (permissionMode === 'plan') assert.equal((edit as any).hookSpecificOutput.permissionDecision, 'deny');
    else assert.deepEqual(edit, {});
    assert.equal((await hook(options, 'Write', { file_path: join(f.root, '..', 'outside.txt') }, permissionMode) as any).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await hook(options, 'Bash', { command: 'echo test', run_in_background: true }, permissionMode) as any).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await hook(options, 'Read', { file_path: join(f.root, 'file.txt') }) as any).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await hook(options, 'Write', { file_path: join(f.root, '.codex', 'config.toml') }, permissionMode) as any).hookSpecificOutput.permissionDecision, 'deny');
  });
  assert.equal(result.received, true); assert.equal(result.closed, true);
});

test('Claude native callback forwards an edit instead of auto-allowing like the legacy preset', async () => {
  await runFixture({ runtime: 'claude', permissionMode: 'default' }, async (options, f, runId) => {
    const response = options.canUseTool!('Write', { file_path: join(f.root, 'test.txt'), content: 'test' }, { signal: new AbortController().signal, toolUseID: 'fixture', requestId: 'fixture' });
    await new Promise(r => setTimeout(r, 10));
    const pending = f.bridge.store.pendingPermissions(runId)[0]!; assert.equal(pending.tool, 'Write');
    f.bridge.store.answerPermission(pending.id, 'deny'); assert.equal((await response)?.behavior, 'deny');
  });
  await runFixture(null, async (options, f) => {
    assert.deepEqual(options.allowedTools, ['Read', 'Glob', 'Grep', 'Edit', 'Write']);
    assert.equal((await hook(options, 'Write', { file_path: join(f.root, 'file.txt') }) as any).hookSpecificOutput.permissionDecision, 'allow');
    assert.equal((await hook(options, 'Bash', { command: 'echo test' }) as any).hookSpecificOutput.permissionDecision, 'ask');
  });
});
for (const override of [{ applied: 'default' }, { setError: true }, { autoSupported: false }]) test(`Claude unavailable mode refuses before prompt: ${JSON.stringify(override)}`, async () => {
  await assert.rejects(runFixture({ runtime: 'claude', permissionMode: 'auto' }, async () => { throw new Error('no tools'); }, override), { code: 'permissions_unavailable', received: false, closed: true });
});
test('Claude post-dispatch mode drift is uncertain, never silently downgraded', async () => {
  await assert.rejects(runFixture({ runtime: 'claude', permissionMode: 'acceptEdits' }, async () => { throw new Error('no tools'); }, { initMode: 'default' }), { code: 'unknown_outcome', received: true, closed: true });
});

test('Claude discovery probes native controls without a model turn or persisted session', async () => {
  let mode = '', options!: Options, next!: Promise<IteratorResult<SDKUserMessage>>, closed = false;
  const result = await discoverClaudePermissions({ stateDir: 'unused', executable: 'unused', maxActive: 1, staleMs: 1000 }, { open: input => {
    options = input.options!; next = (input.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();
    return { initializationResult: async () => ({ claude_code_version: 'fixture' } as any), setPermissionMode: async m => { mode = m; }, reinitialize: async () => ({ current_permission_mode: mode === 'auto' ? 'default' : mode } as any), close: () => { closed = true; } };
  } });
  assert.deepEqual(result.modes.filter(m => !m.available).map(m => m.value), ['auto']);
  assert.equal(options.persistSession, false); assert.deepEqual(options.tools, []); assert.equal(closed, true);
  assert.equal((await next).done, true);
});
test('Claude discovery bounds unresponsive controls', async () => {
  let closed = false;
  await assert.rejects(discoverClaudePermissions({ stateDir: 'unused', executable: 'unused', maxActive: 1, staleMs: 1000 }, { timeoutMs: 10, open: () => ({ initializationResult: () => new Promise(() => {}), setPermissionMode: async () => {}, reinitialize: async () => ({} as any), close: () => { closed = true; } }) }), { code: 'permission_discovery_timeout' });
  assert.equal(closed, true);
});
test('Codex discovery uses native enums and reports new unsupported values without guessing', () => {
  const value = codexPermissionCatalogue({ definitions: { AskForApproval: { oneOf: [{ enum: ['never', 'new-policy'] }, { properties: { granular: {} } }] }, ApprovalsReviewer: { enum: ['user', 'auto_review', 'guardian_subagent'] }, SandboxMode: { enum: ['read-only', 'workspace-write', 'danger-full-access'] } } }, { allowedSandboxModes: ['read-only'] });
  assert.deepEqual(value.approvalPolicy.find(v => v.value === 'new-policy'), { value: 'new-policy', supported: false, allowedByRequirements: null });
  assert.equal(value.sandbox.find(v => v.value === 'danger-full-access')!.allowedByRequirements, false);
  assert.equal(value.approvalsReviewer.find(v => v.value === 'guardian_subagent')!.supported, false);
  assert.throws(() => codexPermissionCatalogue({}, null), { code: 'permission_discovery_failed' });
});
