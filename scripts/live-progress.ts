import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { TERMINAL } from '../src/types.js';

if (process.env.AGENT_BRIDGE_LIVE !== '1') throw new Error('Set AGENT_BRIDGE_LIVE=1; this makes four short native model turns. Build first.');
const root = mkdtempSync(join(tmpdir(), 'bridge-progress-live-')), cwd = join(root, 'workspace');
mkdirSync(cwd); writeFileSync(join(cwd, 'seed.txt'), 'fixture');
const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
const head = git('rev-parse', 'HEAD');
const settings = { ...config(false), stateDir: join(root, 'state') };
const client = new Client({ name: 'progress-acceptance', version: '1' });
const env = Object.fromEntries(Object.entries({ ...process.env, AGENT_BRIDGE_HOME: settings.stateDir,
  AGENT_BRIDGE_CLAUDE_PATH: settings.executable, AGENT_BRIDGE_CODEX_PATH: settings.codexExecutable,
  AGENT_BRIDGE_MAX_ACTIVE: 'unlimited' }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
const evidence: any = { root, platform: process.platform, node: process.version, runs: [] };
const ids: string[] = [];
const tool = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, JSON.stringify(r));
  return (r.structuredContent as any).result;
};
async function wait(id: string) {
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const progress = await tool('get_progress', { runId: id });
    for (const p of progress.pendingInputs) await tool('answer_permission', { permissionId: p.id, decision: 'deny' });
    if (TERMINAL.includes(progress.status) && progress.recovery.readyForHandoff) return progress;
    await delay(750);
  }
  await tool('cancel_run', { runId: id }); throw new Error(`Timed out: ${id}`);
}
try {
  console.log(JSON.stringify({ root }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'mcp'], env }));
  for (const runtime of (process.env.AGENT_BRIDGE_LIVE_RUNTIME ? [process.env.AGENT_BRIDGE_LIVE_RUNTIME] : ['claude', 'codex'])) {
    assert.ok(runtime === 'claude' || runtime === 'codex', 'Runtime must be claude or codex');
    const models = await tool('list_models', { runtime });
    const model = models.models.find((m: any) => runtime === 'claude' ? m.value === 'sonnet' : m.isDefault);
    assert.ok(model, `No selected ${runtime} model in native catalogue`);
    const marker = `PROGRESS_${randomUUID()}`;
    let conversationId: string | undefined;
    for (let turn = 0; turn < 2; turn++) {
      const start = await tool('start_run', { runtime, requestKey: randomUUID(), ...(conversationId ? { conversationId } : { cwd }),
        prompt: turn === 0 ? `Remember ${marker}. Reply with exactly that marker, without tools.` : 'Return the exact marker from my previous message. No tools.', timeoutSeconds: 150,
        model: model.value, effort: model.supportedEffortLevels?.includes('low') ? 'low' : model.defaultEffort ?? 'high' });
      ids.push(start.run.id); conversationId = start.conversation.id;
      const progress = await wait(start.run.id), raw = await tool('get_run', { runId: start.run.id });
      evidence.runs.push({ runtime, turn, id: start.run.id, model: raw.run.model, status: progress.status, recovery: progress.recovery, checkpoint: progress.workspace });
      assert.equal(progress.status, 'succeeded', raw.run.result); assert.ok(raw.run.result.includes(marker));
      assert.equal(progress.recovery.stopReason, 'completed'); assert.equal(progress.recovery.worker, 'exited');
      assert.equal(progress.recovery.runtime, 'exited'); assert.equal(progress.recovery.nextAction, 'continue');
      assert.equal(progress.recovery.readyForFollowUp, true); assert.equal(progress.recovery.transcript, 'runtime_reported');
      assert.equal(progress.workspace.clean, true); assert.equal(progress.workspace.commit, head);
      const transcript = await tool('get_transcript', { runId: start.run.id }); assert.ok(transcript.events.some((e: any) => e.type === 'text' && e.data.text.includes(marker)));
      const handoff = await tool('record_handoff', { runId: start.run.id, summary: 'Exact reply and clean workspace verified by the acceptance script.', unfinishedWork: [], checks: [{ description: 'Exact reply marker', result: 'passed' }] });
      assert.equal(handoff.handoff.source, 'host_reported');
      console.log(JSON.stringify({ runtime, turn, status: progress.status, recovery: progress.recovery.nextAction, checkpointClean: progress.workspace.clean }));
    }
  }
  evidence.passed = true;
} catch (error) { evidence.error = String(error); process.exitCode = 1; }
finally {
  for (const id of ids) {
    try { const run = (await tool('get_run', { runId: id })).run; if (!TERMINAL.includes(run.status)) { await tool('cancel_run', { runId: id }); await wait(id); } } catch { /* Record failure; never signal unrelated processes. */ }
  }
  await client.close(); writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root, passed: evidence.passed ?? false, error: evidence.error }));
}
