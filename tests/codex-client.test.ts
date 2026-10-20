import test from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../src/codex-client.js';
import { codexModels } from '../src/codex-models.js';
const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
test('Codex RPC errors retain the native code independently of message wording', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-rpc-'));
  const client = new CodexClient(process.execPath, root, { args: [fixture, 'discovery', join(root, 'rpc.jsonl')] });
  try { await client.initialize(); await assert.rejects(client.request('configRequirements/read', undefined), { code: 'codex_rpc', rpcCode: -32601 }); }
  finally { await client.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
test('real stdio model probe uses initialize then paginated model/list, no turns or account data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-rpc-')); const record = join(root, 'rpc.jsonl');
  const client = new CodexClient(process.execPath, root, { args: [fixture, 'discovery', record], requestTimeoutMs: 1000 });
  try {
    await client.initialize(); const models = await codexModels(client); assert.equal(models[0]?.defaultReasoningEffort, 'high');
    const messages = readFileSync(record, 'utf8').trim().split('\n').map(s => JSON.parse(s));
    assert.deepEqual(messages.map(m => m.method), ['initialize', 'initialized', 'model/list', 'model/list']);
    assert.equal(messages[3].params.cursor, 'page2');
  } finally { await client.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
test('a protocol timeout does not leave a native child alive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-rpc-'));
  const client = new CodexClient(process.execPath, root, { args: ['-e', 'setInterval(()=>{},1000)'], requestTimeoutMs: 50 });
  const pid = client.child.pid!;
  try { await assert.rejects(client.initialize(), { code: 'codex_timeout' }); }
  finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
  assert.throws(() => process.kill(pid, 0));
});

test('Codex model discovery has an overall deadline and stops its child', async () => {
  const { discoverCodexModels } = await import('../src/codex-models.js');
  let client: CodexClient | undefined;
  await assert.rejects(discoverCodexModels({ stateDir: 'unused', executable: '', codexExecutable: process.execPath, maxActive: 1, staleMs: 120_000 }, {
    timeoutMs: 80,
    open: (exe, cwd) => client = new CodexClient(exe, cwd, { args: ['-e', 'setInterval(()=>{},1000)'], requestTimeoutMs: 10_000 }),
  }), { code: 'model_discovery_timeout' });
  assert.ok(client?.child.pid); assert.throws(() => process.kill(client!.child.pid!, 0));
});

test('a hard owner exit kills its detached Codex process tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-exit-')); const record = join(root, 'rpc.jsonl');
  const owner = fileURLToPath(new URL('./fixtures/codex-owner-exit.ts', import.meta.url));
  try {
    const code = await new Promise<number | null>(resolve => {
      const child = execFile(process.execPath, ['--import', 'tsx', owner, fixture, record], { timeout: 15_000 });
      child.on('exit', resolve);
    });
    assert.equal(code, 17);
    const pid = readFileSync(record, 'utf8').trim().split('\n').map(s => JSON.parse(s)).find(e => e.grandchild)?.grandchild;
    assert.ok(pid);
    const executing = () => {
      try { process.kill(pid, 0); } catch { return false; }
      if (process.platform !== 'win32') {
        try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().startsWith('Z'); } catch { return false; }
      }
      return true;
    };
    for (let n = 0; n < 100 && executing(); n++) await delay(20);
    assert.equal(executing(), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
