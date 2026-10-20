import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../src/config.js';
import { CodexClient } from '../src/codex-client.js';
import { TERMINAL, type Runtime, type Conversation, type Run } from '../src/types.js';

if (process.env.AGENT_BRIDGE_LIVE !== '1') throw new Error('Set AGENT_BRIDGE_LIVE=1; this test consumes twelve short native model turns.');
const root = mkdtempSync(join(tmpdir(), 'bridge-fork-live-')), repo = join(root, 'source');
mkdirSync(repo); writeFileSync(join(repo, 'seed.txt'), 'base\n');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(repo, 'init', '-q'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture');
const settings = { ...config(false), stateDir: join(root, 'state'), maxActive: 'unlimited' as const };
const { Bridge } = await import(new URL('../dist/service.js', import.meta.url).href);
const bridge = new Bridge(settings), client = new Client({ name: 'fork-acceptance', version: '1' });
const evidence: any = { root, platform: process.platform, node: process.version, runs: [] };
const env = Object.fromEntries(Object.entries({ ...process.env, AGENT_BRIDGE_HOME: settings.stateDir,
  AGENT_BRIDGE_CLAUDE_PATH: settings.executable, AGENT_BRIDGE_CODEX_PATH: settings.codexExecutable, AGENT_BRIDGE_MAX_ACTIVE: 'unlimited' })
  .filter((e): e is [string, string] => typeof e[1] === 'string'));
const tool = async (name: string, args: Record<string, unknown>) => {
  const value = await client.callTool({ name, arguments: args }); assert.ok(!value.isError, JSON.stringify(value));
  return (value.structuredContent as any).result;
};
async function wait(id: string) {
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    const s = bridge.get(id);
    for (const p of s.permissions) {
      // Exact fixture edits only; no shell approvals are needed for this test.
      const localPatch = p.tool === 'codex.fileChange' && Array.isArray(p.input.changes) && p.input.changes.every((c: any) => typeof c.path === 'string' && (c.path === 'branch.txt' || c.path === join(s.conversation.cwd, 'branch.txt')));
      bridge.store.answerPermission(p.id, localPatch ? 'allow' : 'deny');
    }
    if (TERMINAL.includes(s.run.status)) {
      evidence.runs.push({ run: s.run, conversation: s.conversation });
      assert.equal(s.run.status, 'succeeded', JSON.stringify(s));
      return s;
    }
    await delay(300);
  }
  bridge.store.requestCancel(id); throw new Error(`Timeout waiting for ${id}`);
}
async function history(c: Conversation) {
  if (c.runtime === 'claude') return JSON.stringify(await getSessionMessages(c.id, { dir: c.cwd }));
  const native = new CodexClient(settings.codexExecutable!, c.cwd);
  try {
    await native.initialize();
    const turns = await native.request('thread/turns/list', { threadId: c.nativeId, limit: 100, itemsView: 'full', sortDirection: 'asc' });
    return JSON.stringify(turns.data);
  } finally { await native.close(); }
}
try {
  console.log(JSON.stringify({ root }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'mcp'], env }));
  assert.ok((await client.listTools()).tools.some(t => t.name === 'fork_conversation'));
  for (const runtime of ['claude', 'codex'] as Runtime[]) {
    if (process.env.AGENT_BRIDGE_LIVE_RUNTIME && process.env.AGENT_BRIDGE_LIVE_RUNTIME !== runtime) continue;
    const models = await tool('list_models', { runtime });
    const model = models.models.find((m: any) => runtime === 'claude' ? m.value === 'sonnet' : m.isDefault);
    assert.ok(model); const effort = model.supportedEffortLevels?.includes('low') ? 'low' : model.defaultEffort ?? 'high';
    const marker = `PARENT_${randomUUID()}`, branchMarker = `FORK_${randomUUID()}`;
    const source = await wait((await tool('start_run', { runtime, requestKey: randomUUID(), cwd: repo, mode: 'write', baseRef: 'HEAD', model: model.value, effort,
      prompt: `Remember the secret ${marker}. Reply with exactly that secret. Do not use tools or write it to disk.`, timeoutSeconds: 200 })).run.id);
    writeFileSync(join(source.conversation.cwd, 'seed.txt'), 'parent uncommitted\n');
    writeFileSync(join(source.conversation.cwd, 'untracked.txt'), 'parent untracked\n');
    const before = await history(source.conversation);
    const forkInput = { requestKey: randomUUID(), sourceConversationId: source.conversation.id,
      prompt: `Recall the secret I asked you to remember and include it in your answer. Remember a separate branch secret ${branchMarker}. Use the file-edit tool to create branch.txt containing exactly "child-only". Do not use shell commands.`, timeoutSeconds: 200 };
    const submitted = await tool('fork_conversation', forkInput);
    assert.equal((await tool('fork_conversation', forkInput)).run.id, submitted.run.id);
    const fork = await wait(submitted.run.id);
    assert.ok(fork.run.result.includes(marker));
    assert.notEqual(fork.conversation.id, source.conversation.id);
    if (runtime === 'codex') assert.notEqual(fork.conversation.nativeId, source.conversation.nativeId);
    assert.equal(readFileSync(join(fork.conversation.cwd, 'seed.txt'), 'utf8').trim(), 'parent uncommitted');
    assert.equal(readFileSync(join(fork.conversation.cwd, 'untracked.txt'), 'utf8').trim(), 'parent untracked');
    assert.equal(readFileSync(join(fork.conversation.cwd, 'branch.txt'), 'utf8').trim(), 'child-only');
    assert.equal(git(source.conversation.cwd, 'status', '--porcelain').includes('branch.txt'), false);
    assert.equal(await history(source.conversation), before, 'Fork must not append to parent history');
    const resumed = await wait((await tool('start_run', { requestKey: randomUUID(), conversationId: fork.conversation.id,
      prompt: 'Return both secrets I asked you to remember. Do not use tools.', timeoutSeconds: 200 })).run.id);
    assert.ok(resumed.run.result.includes(marker) && resumed.run.result.includes(branchMarker));
    const parent = await wait((await tool('start_run', { requestKey: randomUUID(), conversationId: source.conversation.id,
      prompt: 'Return all secrets I asked you to remember. Do not use tools.', timeoutSeconds: 200 })).run.id);
    assert.ok(parent.run.result.includes(marker)); assert.equal(parent.run.result.includes(branchMarker), false);
    const review = await wait((await tool('start_run', { runtime, requestKey: randomUUID(), cwd: repo, model: model.value, effort,
      prompt: `Remember ${marker}. Reply exactly with it, without tools.`, timeoutSeconds: 200 })).run.id);
    const reviewFork = await wait((await tool('fork_conversation', { requestKey: randomUUID(), sourceConversationId: review.conversation.id,
      prompt: 'Return the secret I asked you to remember. Do not use tools.', timeoutSeconds: 200 })).run.id);
    assert.equal(reviewFork.conversation.mode, 'review'); assert.ok(reviewFork.run.result.includes(marker));
    console.log(JSON.stringify({ runtime, writeFork: true, historyPreserved: true, parentUnchanged: true, resumed: true, reviewFork: true }));
  }
  evidence.passed = true;
} catch (error) { evidence.error = String(error); process.exitCode = 1; }
finally {
  for (const r of bridge.store.listRuns()) if (!TERMINAL.includes(r.status)) bridge.store.requestCancel(r.id);
  const cleanupUntil = Date.now() + 65_000;
  while (bridge.store.listRuns().some((r: Run) => !TERMINAL.includes(r.status)) && Date.now() < cleanupUntil) await delay(300);
  const pending: Run[] = bridge.store.listRuns().filter((r: Run) => !TERMINAL.includes(r.status));
  if (pending.length) { evidence.cleanupPending = pending.map(r => r.id); evidence.passed = false; process.exitCode = 1; }
  await client.close(); bridge.close();
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root, passed: evidence.passed ?? false, error: evidence.error }));
}
