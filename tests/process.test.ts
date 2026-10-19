import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { discoverModels } from '../src/models.js';

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
    assert.equal(first.events.find((e: any) => e.type === 'started').data.effortReported, false);
    const second = await f.getTerminal(b.run.id);
    assert.equal(second.run.status, 'succeeded');
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
    const a = await f.command(['start'], { requestKey: 'cancel', cwd: f.root, prompt: 'fixture:delay' });
    for (let i = 0; i < 50; i++) {
      if ((await f.command(['get', a.run.id])).events.some((e: any) => e.type === 'started')) break;
      await delay(100);
    }
    await f.command(['cancel', a.run.id]);
    assert.equal((await f.getTerminal(a.run.id)).run.status, 'cancelled');
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
