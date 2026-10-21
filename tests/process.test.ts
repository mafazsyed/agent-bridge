import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { discoverModels } from '../src/models.js';
import { discoverAccountLimits } from '../src/limits.js';
import { pathToFileURL } from 'node:url';

// Uses the actual compiled CLI, detached worker, SDK transport and SQLite. Only inference is fake.
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);
const cli = resolve('dist/cli.js');
async function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-process-')));
  const env = { ...process.env, AGENT_BRIDGE_HOME: join(root, 'state'), AGENT_BRIDGE_CLAUDE_PATH: resolve('tests/fixtures/fake-claude.js'), AGENT_BRIDGE_FIXTURE_LOG: join(root, 'processes.jsonl'), AGENT_BRIDGE_FIXTURE_TRACE: join(root, 'protocol.jsonl') };
  const command = (args: string[], input?: object): Promise<any> => new Promise((res, rej) => {
    const child = execFile(process.execPath, [cli, ...args], { env, timeout: 15_000 }, (error, stdout, stderr) => error ? rej(new Error(`${error.message}\n${stderr}`)) : res(JSON.parse(stdout)));
    child.stdin?.end(input ? JSON.stringify(input) : '');
  });
  const getTerminal = async (id: string) => {
    for (let n = 0; n < 100; n++) {
      const x = await command(['get', id]);
      if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(x.run.status)) return x;
      await delay(100);
    }
    throw new Error('Fixture worker did not finish');
  };
  const cleanup = async () => {
    const runs = await command(['runs']);
    for (const run of runs) {
      if (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(run.status)) { await command(['cancel', run.id]); await getTerminal(run.id); }
    }
    await delay(300);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { root, env, command, getTerminal, cleanup };
}

test('real stdio MCP disconnect leaves its delegated worker alive', async () => {
  const f = await fixture();
  const client = new Client({ name: 'acceptance', version: '1' });
  try {
    const env = Object.fromEntries(Object.entries(f.env).filter((item): item is [string, string] => typeof item[1] === 'string'));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env }));
    const reply = await client.callTool({ name: 'start_run', arguments: { requestKey: 'mcp-detached', cwd: f.root, prompt: 'fixture:delay' } });
    const started = (reply.structuredContent as any).result;
    await client.close();
    assert.equal((await f.getTerminal(started.run.id)).run.status, 'succeeded');
  } finally { await client.close(); await f.cleanup(); }
});

test('detached Codex fork worker snapshots files, resumes only the child and releases failed-copy reservations', async () => {
  const f = await fixture();
  try {
    Object.assign(f.env, { AGENT_BRIDGE_CODEX_PATH: process.execPath });
    const record = join(f.root, 'codex-rpc.jsonl');
    const fixtureUrl = pathToFileURL(resolve('tests/fixtures/codex-app-server.mjs')).href;
    // Node stands in for the native executable; app-server is its fixture script.
    writeFileSync(join(f.root, 'app-server'), `process.argv = [process.execPath, 'fixture', 'ok', ${JSON.stringify(record)}]; await import(${JSON.stringify(fixtureUrl)});`);
    writeFileSync(join(f.root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(f.root, '.gitignore'), 'state/\n*.jsonl\n');
    writeFileSync(join(f.root, 'seed'), 'base');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.root, stdio: 'ignore' });
    git('init', '-q'); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture');
    const source = await f.command(['start'], { requestKey: 'source', runtime: 'codex', cwd: f.root, mode: 'write', baseRef: 'HEAD', prompt: 'Seed', model: 'native-model', effort: 'low' });
    assert.equal((await f.getTerminal(source.run.id)).run.status, 'succeeded');
    writeFileSync(join(source.conversation.cwd, 'seed'), 'dirty parent');
    const child = await f.command(['fork'], { requestKey: 'fork', sourceConversationId: source.conversation.id, prompt: 'Alternative' });
    const done = await f.getTerminal(child.run.id);
    assert.equal(done.run.status, 'succeeded', JSON.stringify(done.run));
    assert.equal(done.conversation.nativeId, 'fork-thread');
    assert.ok(done.conversation.fork.snapshotTree);
    assert.equal(readFileSync(join(done.conversation.cwd, 'seed'), 'utf8'), 'dirty parent');
    const next = await f.command(['start'], { requestKey: 'child-next', conversationId: child.conversation.id, prompt: 'Continue' });
    assert.equal((await f.getTerminal(next.run.id)).run.status, 'succeeded');
    const rpc = readFileSync(record, 'utf8').trim().split('\n').map(s => JSON.parse(s));
    assert.deepEqual(rpc.filter(r => r.method === 'turn/start').map(r => r.params.threadId), ['native-thread', 'fork-thread', 'fork-thread']);
    mkdirSync(join(source.conversation.cwd, '.codex')); writeFileSync(join(source.conversation.cwd, '.codex', 'config.toml'), 'fixture=true');
    const unsafe = await f.command(['fork'], { requestKey: 'unsafe-copy', sourceConversationId: source.conversation.id, prompt: 'Must not run' });
    const failed = await f.getTerminal(unsafe.run.id);
    assert.equal(failed.run.status, 'failed'); assert.equal(failed.run.errorCode, 'fork_source_agent_config_changed');
    const parentNext = await f.command(['start'], { requestKey: 'source-next', conversationId: source.conversation.id, prompt: 'Continue' });
    assert.equal((await f.getTerminal(parentNext.run.id)).run.status, 'succeeded', 'Failed preparation releases the parent');
  } finally { await f.cleanup(); }
});

test('CLI and real MCP model discovery use runtime metadata without a run or inference prompt', async () => {
  const f = await fixture();
  const client = new Client({ name: 'catalogue-acceptance', version: '1' });
  try {
    const cliResult = await f.command(['models']);
    assert.equal(existsSync(f.env.AGENT_BRIDGE_HOME), false);
    const env = Object.fromEntries(Object.entries(f.env).filter((item): item is [string, string] => typeof item[1] === 'string'));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env }));
    const replies = await Promise.all(Array.from({ length: 3 }, () => client.callTool({ name: 'list_models', arguments: {} })));
    const reply = replies[0]!;
    assert.equal(reply.isError, undefined);
    assert.deepEqual((reply.structuredContent as any).result.models, cliResult.models);
    assert.equal(cliResult.models[0].value, 'fixture-alias');
    assert.deepEqual(cliResult.models[0].supportedEffortLevels, ['low', 'high']);
    assert.ok(!JSON.stringify([cliResult, replies]).includes('private-fixture'), 'Account fields must not be returned');
    const probes = readFileSync(join(f.root, 'processes.jsonl'), 'utf8').trim().split('\n');
    assert.equal(probes.length, 2, 'One CLI probe and one shared MCP probe');
    assert.deepEqual(await f.command(['runs']), []);
    assert.deepEqual(await f.command(['conversations']), []);
    const messages = readFileSync(join(f.root, 'protocol.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(messages.some(m => m.type === 'control_request'));
    assert.ok(!messages.some(m => m.type === 'user'), 'Discovery must never dispatch an inference turn');
  } finally { await client.close(); await f.cleanup(); }
});
test('CLI and real MCP account limits send no inference, skip behavioral scans, and preserve account privacy', async () => {
  const f = await fixture();
  const client = new Client({ name: 'limits-acceptance', version: '1' });
  try {
    const cliResult = await f.command(['limits', 'claude']);
    assert.equal(existsSync(f.env.AGENT_BRIDGE_HOME), false);
    const env = Object.fromEntries(Object.entries(f.env).filter((item): item is [string, string] => typeof item[1] === 'string'));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env }));
    const replies = await Promise.all(Array.from({ length: 3 }, () => client.callTool({ name: 'get_account_limits', arguments: { runtime: 'claude' } })));
    for (const reply of replies) {
      assert.equal(reply.isError, undefined);
      assert.deepEqual((reply.structuredContent as any).result.buckets, cliResult.buckets);
      assert.equal(JSON.stringify(reply).includes('PRIVATE'), false);
    }
    const messages = readFileSync(join(f.root, 'protocol.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const reads = messages.filter(m => m.request?.subtype === 'get_usage');
    assert.equal(reads.length, 2); assert.ok(reads.every(m => m.request.skip_behaviors === true));
    assert.equal(messages.some(m => m.type === 'user'), false);
    assert.deepEqual(await f.command(['runs']), []);
  } finally { await client.close(); await f.cleanup(); }
});

test('account limits timeout terminates its actual SDK child', async () => {
  const f = await fixture();
  try {
    await assert.rejects(discoverAccountLimits({ executable: f.env.AGENT_BRIDGE_CLAUDE_PATH, stateDir: f.env.AGENT_BRIDGE_HOME, maxActive: 1, staleMs: 120_000 }, 'claude', {
      timeoutMs: 2000, openClaude: input => query({ ...input, options: { ...input.options, env: { ...f.env, AGENT_BRIDGE_FIXTURE_INIT_HANG: '1' } } }),
    }), { code: 'limits_timeout' });
    const [{ pid }] = readFileSync(join(f.root, 'processes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    let alive = true;
    for (let n = 0; n < 100 && alive; n++) { try { process.kill(pid, 0); await delay(50); } catch { alive = false; } }
    assert.equal(alive, false);
    assert.equal(existsSync(f.env.AGENT_BRIDGE_HOME), false);
  } finally { await f.cleanup(); }
});

test('model discovery timeout terminates the actual SDK child process', async () => {
  const f = await fixture();
  try {
    await assert.rejects(discoverModels({ executable: f.env.AGENT_BRIDGE_CLAUDE_PATH, stateDir: f.env.AGENT_BRIDGE_HOME, maxActive: 1, staleMs: 120_000 }, {
      timeoutMs: 2000,
      open: input => query({ ...input, options: { ...input.options, env: { ...f.env, AGENT_BRIDGE_FIXTURE_INIT_HANG: '1' } } }),
    }), { code: 'model_discovery_timeout' });
    const [{ pid }] = readFileSync(join(f.root, 'processes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    let alive = true;
    for (let n = 0; n < 100 && alive; n++) {
      try { process.kill(pid, 0); await delay(50); } catch { alive = false; }
    }
    assert.equal(alive, false, 'Timed-out discovery must not leave its runtime running');
    assert.equal(existsSync(f.env.AGENT_BRIDGE_HOME), false);
  } finally { await f.cleanup(); }
});

test('detached work survives host exit; queued turns and retries dispatch once', async () => {
  const f = await fixture();
  try {
    const input = { requestKey: 'first', cwd: f.root, prompt: 'fixture:delay' };
    const a = await f.command(['start'], input); // This client exits immediately.
    const dup = await f.command(['start'], input);
    assert.equal(a.run.id, dup.run.id);
    const b = await f.command(['start'], { requestKey: 'second', conversationId: a.conversation.id, prompt: 'fixture:effort' });
    const first = await f.getTerminal(a.run.id);
    assert.equal(first.run.status, 'succeeded');
    assert.equal(first.run.usage.cumulative.estimatedCostUsd, 0.1);
    assert.equal(first.events.find((e: any) => e.type === 'started').data.effortReported, false);
    const second = await f.getTerminal(b.run.id);
    assert.equal(second.run.status, 'succeeded');
    assert.equal(second.run.usage.cumulative.estimatedCostUsd, 0.2, 'Resumed cumulative cost must not be summed with the first snapshot');
    const started = second.events.find((e: any) => e.type === 'started').data;
    assert.equal(started.effortRequested, 'high'); assert.equal(started.effortApplied, 'medium');
    assert.equal(started.effortReported, true);
    const processes = readFileSync(join(f.root, 'processes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(processes.length, 2);
    assert.equal(processes[0].session, processes[1].session);
    assert.ok(processes[1].args.some((arg: string) => arg.startsWith('--resume=')));
    assert.ok(processes[0].args.includes('--effort=high'));
  } finally { await f.cleanup(); }
});

test('cancellation stops the owned runtime; transport failure is uncertain, not silently retried', async () => {
  const f = await fixture();
  try {
    // Keep the fixture active until cancelled; a 1.5-second completion races Windows process probes.
    const a = await f.command(['start'], { requestKey: 'cancel', cwd: f.root, prompt: 'fixture:hang fixture:slow-cancel' });
    let started = false;
    for (let i = 0; i < 50; i++) {
      if ((await f.command(['get', a.run.id])).events.some((e: any) => e.type === 'started')) { started = true; break; }
      await delay(100);
    }
    assert.equal(started, true, 'Exercise cancellation after the runtime starts');
    await f.command(['cancel', a.run.id]);
    const cancelled = await f.getTerminal(a.run.id);
    assert.equal(cancelled.run.status, 'cancelled');
    assert.equal(cancelled.run.diagnostics.runtime.state, 'exited');
    const b = await f.command(['start'], { requestKey: 'crash', conversationId: a.conversation.id, prompt: 'fixture:crash' });
    const failed = await f.getTerminal(b.run.id);
    assert.equal(failed.run.status, 'unknown');
    assert.equal(failed.run.errorCode, 'unknown_outcome');
    await assert.rejects(f.command(['start'], { requestKey: 'blocked', conversationId: a.conversation.id, prompt: 'fixture:result' }), /unknown/);
  } finally { await f.cleanup(); }
});

test('a real worker deadline closes the SDK transport and settles an unfinished run as uncertain', async () => {
  const f = await fixture();
  try {
    const a = await f.command(['start'], { requestKey: 'deadline', cwd: f.root, prompt: 'fixture:hang', timeoutSeconds: 10 });
    const result = await f.getTerminal(a.run.id);
    assert.equal(result.run.status, 'unknown');
    assert.equal(result.run.errorCode, 'timeout');
  } finally { await f.cleanup(); }
});

test('native SDK turns drain EOF before transcript flush, including a native / legacy / native resume', async () => {
  const f = await fixture();
  try {
    execFileSync('git', ['init', '-q', f.root]);
    execFileSync('git', ['-C', f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture']);
    let conversationId: string | undefined;
    for (const permissionMode of ['plan', null, 'bypassPermissions'] as const) {
      const run = await f.command(['start'], { requestKey: `drain-${permissionMode}`, prompt: 'fixture:flush',
        ...(conversationId ? { conversationId } : { cwd: f.root, mode: 'write', baseRef: 'HEAD' }),
        permissions: permissionMode ? { runtime: 'claude', permissionMode } : null });
      conversationId ??= run.conversation.id;
      const result = await f.getTerminal(run.run.id);
      assert.equal(result.run.status, 'succeeded', result.run.result);
      assert.equal(result.events.find((e: any) => e.type === 'started').data.permissionModeApplied, permissionMode ?? 'default');
      const trace = readFileSync(f.env.AGENT_BRIDGE_FIXTURE_TRACE, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(trace.filter(e => e.fixture === 'transcript_flushed').length, ['plan', null, 'bypassPermissions'].indexOf(permissionMode) + 1);
    }
  } finally { await f.cleanup(); }
});

for (const stop of ['cancel', 'deadline']) test(`native setup ${stop} ends without a prompt or uncertain-conversation fence`, async () => {
  const f = await fixture();
  try {
    Object.assign(f.env, { AGENT_BRIDGE_FIXTURE_INIT_HANG: '1' });
    const input = { cwd: f.root, prompt: 'fixture:result', permissions: { runtime: 'claude', permissionMode: 'default' } };
    const run = await f.command(['start'], { ...input, requestKey: `setup-${stop}`, timeoutSeconds: 10 });
    for (let i = 0; i < 60; i++) {
      if (existsSync(f.env.AGENT_BRIDGE_FIXTURE_TRACE)) break;
      await delay(100);
    }
    assert.equal(existsSync(f.env.AGENT_BRIDGE_FIXTURE_TRACE), true, 'Fixture must reach the setup control request');
    if (stop === 'cancel') await f.command(['cancel', run.run.id]);
    const result = await f.getTerminal(run.run.id);
    assert.equal(result.run.status, stop === 'cancel' ? 'cancelled' : 'failed', result.run.result);
    assert.equal(result.run.errorCode, stop === 'cancel' ? 'cancelled' : 'timeout');
    const trace = readFileSync(f.env.AGENT_BRIDGE_FIXTURE_TRACE, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(!trace.some(e => e.type === 'user'));
    delete (f.env as NodeJS.ProcessEnv).AGENT_BRIDGE_FIXTURE_INIT_HANG;
    const retry = await f.command(['start'], { requestKey: `after-${stop}`, conversationId: run.conversation.id, prompt: 'fixture:flush' });
    assert.equal((await f.getTerminal(retry.run.id)).run.status, 'succeeded');
  } finally { await f.cleanup(); }
});
test('a native shutdown crash retains the completed answer with its uncertainty warning', async () => {
  const f = await fixture();
  try {
    const run = await f.command(['start'], { requestKey: 'shutdown-crash', cwd: f.root, prompt: 'fixture:flush-crash', permissions: { runtime: 'claude', permissionMode: 'default' } });
    const result = await f.getTerminal(run.run.id);
    assert.equal(result.run.status, 'unknown');
    assert.equal(result.run.errorCode, 'unknown_outcome');
    assert.match(result.run.result, /Completion could not be verified/);
    assert.match(result.run.result, /fixture done/);
    assert.equal(result.run.usage.cumulative.estimatedCostUsd, 0.1);
    assert.equal(result.run.usage.turn.tokens.output, 8);
  } finally { await f.cleanup(); }
});

for (const crash of [false, true]) test(`allowance result preserves cause and observed process shutdown through real SDK: crash=${crash}`, async () => {
  const f = await fixture();
  try {
    const started = await f.command(['start'], { requestKey: 'allowance', cwd: f.root, prompt: `fixture:allowance fixture:frames ${crash ? 'fixture:flush-crash' : 'fixture:flush'}`, model: 'fixture-alias', permissions: { runtime: 'claude', permissionMode: 'default' } });
    const done = await f.getTerminal(started.run.id);
    assert.equal(done.run.status, crash ? 'unknown' : 'failed');
    assert.equal(done.run.errorCode, crash ? 'unknown_outcome' : 'allowance_exhausted');
    assert.equal(done.run.diagnostics.stopReason, 'allowance_exhausted');
    assert.equal(done.run.diagnostics.runtime.state, 'exited');
    assert.equal(done.run.diagnostics.runtime.exitCode, crash ? 2 : 0);
    assert.equal(done.run.diagnostics.transcript, crash ? 'unverified' : 'runtime_reported');
    let progress;
    for (let n = 0; n < 40; n++) {
      progress = await f.command(['progress', started.run.id]);
      if (progress.recovery.readyForHandoff) break;
      await delay(50);
    }
    assert.equal(progress.recovery.readyForHandoff, true);
    assert.equal(progress.recovery.nextAction, crash ? 'inspect' : 'retry_when_available');
    assert.equal(progress.workspace.status, 'unavailable', 'Non-Git workspace must never be called clean');
    const transcript = await f.command(['transcript', started.run.id]);
    assert.deepEqual(transcript.events.filter((e: any) => e.type === 'text').map((e: any) => e.data.text), ['first block', 'second block', 'first block']);
    const handoff = await f.command(['handoff', started.run.id], { summary: 'Await provider reset', unfinishedWork: ['Continue review'], checks: [{ description: 'No validation ran', result: 'not_run' }] });
    assert.equal(handoff.handoff.source, 'host_reported'); assert.equal(handoff.recovery.stopReason, 'allowance_exhausted');
    assert.equal((await f.command(['checkpoint', started.run.id])).workspace.clean, null);
  } finally { await f.cleanup(); }
});
