import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge } from '../src/service.js';
import { createMcpServer } from '../src/mcp.js';

test('MCP advertises lifecycle tools and executes real handler/schema paths', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-mcp-')));
  const bridge = new Bridge({ stateDir: join(root, 'state'), executable: 'unused', maxActive: 1, staleMs: 120_000 }, () => {});
  const server = createMcpServer(bridge);
  const client = new Client({ name: 'fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['answer_permission', 'cancel_run', 'get_run', 'list_conversations', 'list_models', 'list_permission_modes', 'list_runs', 'start_run', 'wait_run']);
    const start = await client.callTool({ name: 'start_run', arguments: { requestKey: 'mcp-fixture', prompt: 'Review', cwd: root } });
    assert.equal(start.isError, undefined);
    const payload = (start.structuredContent as any).result;
    const read = await client.callTool({ name: 'get_run', arguments: { runId: payload.run.id } });
    assert.equal((read.structuredContent as any).result.run.status, 'queued');
    const invalid = await client.callTool({ name: 'start_run', arguments: { requestKey: 'oops', prompt: '' } });
    assert.equal(invalid.isError, true);
    const native = await client.callTool({ name: 'start_run', arguments: { requestKey: 'native-plan', prompt: 'Plan', cwd: root,
      permissions: { runtime: 'claude', permissionMode: 'plan' } } });
    assert.equal(native.isError, undefined);
    assert.deepEqual((native.structuredContent as any).result.run.permissions, { runtime: 'claude', permissionMode: 'plan' });
    const mixed = await client.callTool({ name: 'start_run', arguments: { requestKey: 'mixed', prompt: 'Plan', cwd: root,
      permissions: { runtime: 'claude', permissionMode: 'default', sandbox: 'danger-full-access' } } });
    assert.equal(mixed.isError, true);
    bridge.store.attachWorker(payload.run.id, 'fixture', process.pid);
    bridge.store.claimRun(payload.run.id, 'fixture');
    const permission = bridge.store.requestPermission(payload.run.id, 'fixture', 'AskUserQuestion', { questions: [{ question: 'Which colour?' }] }, 'fixture');
    const waiting = await client.callTool({ name: 'wait_run', arguments: { runId: payload.run.id, seconds: 0 } });
    assert.equal((waiting.structuredContent as any).result.permissions[0].id, permission.id);
    const badAnswer = await client.callTool({ name: 'answer_permission', arguments: { permissionId: permission.id, decision: 'allow' } });
    assert.equal(badAnswer.isError, true);
    const depth = process.env.AGENT_BRIDGE_DELEGATION_DEPTH;
    process.env.AGENT_BRIDGE_DELEGATION_DEPTH = '1';
    try {
      const nestedAnswer = await client.callTool({ name: 'answer_permission', arguments: { permissionId: permission.id, decision: 'allow', answers: { 'Which colour?': 'Blue' } } });
      assert.equal(nestedAnswer.isError, true);
      const nestedCancel = await client.callTool({ name: 'cancel_run', arguments: { runId: payload.run.id } });
      assert.equal(nestedCancel.isError, true);
      assert.equal(bridge.store.getRun(payload.run.id).cancelRequested, false);
      assert.equal(bridge.store.getPermission(permission.id).decision, 'pending');
    } finally { if (depth === undefined) delete process.env.AGENT_BRIDGE_DELEGATION_DEPTH; else process.env.AGENT_BRIDGE_DELEGATION_DEPTH = depth; }
    const answer = await client.callTool({ name: 'answer_permission', arguments: { permissionId: permission.id, decision: 'allow', answers: { 'Which colour?': 'Blue' } } });
    assert.equal(answer.isError, undefined);
    assert.deepEqual(bridge.store.consumePermission(permission.id, 'fixture')?.answers, { 'Which colour?': 'Blue' });
    await client.callTool({ name: 'cancel_run', arguments: { runId: payload.run.id } });
    assert.equal(bridge.store.getRun(payload.run.id).cancelRequested, true);
  } finally { await client.close(); await server.close(); bridge.close(); rmSync(root, { recursive: true, force: true }); }
});
