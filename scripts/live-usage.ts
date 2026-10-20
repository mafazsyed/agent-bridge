import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { TERMINAL, type Runtime } from '../src/types.js';

if (process.env.AGENT_BRIDGE_LIVE !== '1') throw new Error('Set AGENT_BRIDGE_LIVE=1; this runs four short native model turns.');
const root = mkdtempSync(join(tmpdir(), 'bridge-usage-live-'));
const settings = { ...config(false), stateDir: join(root, 'state'), maxActive: 'unlimited' as const };
const { Bridge } = await import(new URL('../dist/service.js', import.meta.url).href);
const bridge = new Bridge(settings);
const client = new Client({ name: 'usage-acceptance', version: '1' });
const evidence: any = { root, platform: process.platform, node: process.version, limits: {}, runs: [] };
const env = Object.fromEntries(Object.entries({ ...process.env, AGENT_BRIDGE_HOME: settings.stateDir,
  AGENT_BRIDGE_CLAUDE_PATH: settings.executable, AGENT_BRIDGE_CODEX_PATH: settings.codexExecutable,
  AGENT_BRIDGE_MAX_ACTIVE: 'unlimited' }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
const tool = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, JSON.stringify(r));
  return (r.structuredContent as any).result;
};
async function wait(id: string) {
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const s = bridge.get(id);
    for (const p of s.permissions) bridge.store.answerPermission(p.id, 'deny');
    if (TERMINAL.includes(s.run.status)) return s;
    await delay(250);
  }
  bridge.store.requestCancel(id); throw new Error(`Timed out: ${id}`);
}
try {
  console.log(JSON.stringify({ root }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'mcp'], env }));
  assert.ok((await client.listTools()).tools.some(t => t.name === 'get_account_limits'));
  const jobs = [];
  for (const runtime of ['claude', 'codex'] as Runtime[]) {
    const limits = await tool('get_account_limits', { runtime });
    evidence.limits[runtime] = { status: limits.status, fetchedAt: limits.fetchedAt, buckets: limits.buckets.length, experimental: limits.experimental };
    assert.equal(limits.status, 'available', `${runtime} signed-in live account should expose quota windows`);
    assert.ok(limits.buckets.length > 0);
    const models = await tool('list_models', { runtime });
    const model = models.models.find((m: any) => runtime === 'claude' ? m.value === 'sonnet' : m.isDefault);
    assert.ok(model);
    const marker = `USAGE_${randomUUID()}`;
    jobs.push({ runtime, marker, started: await tool('start_run', { runtime, requestKey: randomUUID(), cwd: root,
      prompt: `Remember ${marker}. Reply with exactly that marker, without tools.`, timeoutSeconds: 150,
      model: model.value, effort: model.supportedEffortLevels?.includes('low') ? 'low' : model.defaultEffort ?? 'high' }) });
  }
  for (const { runtime, marker, started } of jobs) {
    const first = await wait(started.run.id);
    assert.equal(first.run.status, 'succeeded', first.run.result);
    assert.ok(first.run.result.includes(marker));
    assert.equal(first.run.usage?.runtime, runtime); assert.equal(first.run.usage?.status, 'reported');
    if (runtime === 'claude') assert.ok(first.run.usage.turn.tokens.output > 0);
    else assert.ok(first.run.usage.cumulative.tokens.total > 0);
    const second = await tool('start_run', { requestKey: randomUUID(), conversationId: started.conversation.id,
      prompt: 'Return the exact marker I asked you to remember. No tools.', timeoutSeconds: 150 });
    const resumed = await wait(second.run.id);
    assert.equal(resumed.run.status, 'succeeded', resumed.run.result); assert.ok(resumed.run.result.includes(marker));
    assert.equal(resumed.run.usage?.runtime, runtime); assert.equal(resumed.run.usage?.status, 'reported');
    if (runtime === 'codex') {
      assert.ok(resumed.run.usage.cumulative.tokens.total >= first.run.usage.cumulative.tokens.total, 'Native thread totals must survive resume');
    } else {
      assert.ok(resumed.run.usage.cumulative.estimatedCostUsd >= first.run.usage.cumulative.estimatedCostUsd, 'Native session spend must survive resume');
      for (const before of first.run.usage.cumulative.models ?? []) {
        const after = resumed.run.usage.cumulative.models?.find((m: any) => m.model === before.model);
        assert.ok(after, 'Resumed session must retain model totals');
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) if (before.tokens[key] !== null) {
          assert.ok(after.tokens[key] !== null && after.tokens[key] >= before.tokens[key], `Cumulative ${key} must survive resume`);
        }
      }
    }
    assert.deepEqual((await tool('get_run', { runId: second.run.id })).run.usage, resumed.run.usage);
    evidence.runs.push({ runtime, first: first.run, resumed: resumed.run });
    console.log(JSON.stringify({ runtime, first: first.run.status, resumed: resumed.run.status, usageRecorded: true, limits: evidence.limits[runtime] }));
  }
  evidence.passed = true;
} catch (error) { evidence.error = String(error); process.exitCode = 1; }
finally {
  for (const run of bridge.store.listRuns()) if (!TERMINAL.includes(run.status)) {
    bridge.store.requestCancel(run.id);
    await wait(run.id).catch(() => {});
  }
  await client.close(); bridge.close();
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root, passed: evidence.passed ?? false, error: evidence.error }));
}
