import assert from 'node:assert/strict';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';

if (process.env.AGENT_BRIDGE_LIVE !== '1' || Number(process.env.AGENT_BRIDGE_DELEGATION_DEPTH ?? 0) > 0) throw new Error('Run explicitly as a top-level live acceptance host.');
const root = resolve('.local', `claude-to-codex-${Date.now()}`); mkdirSync(root, { recursive: true });
const cwd = realpathSync.native(root), state = join(cwd, 'state');
const marker = `HOST_${randomUUID()}`; writeFileSync(join(cwd, 'marker.txt'), marker);
const settings = config(false);
const allowed = ['list_models', 'start_run', 'get_run', 'wait_run', 'list_runs', 'list_conversations'].map(s => `mcp__agent-bridge__${s}`);
let result: any; const calls: unknown[] = [];
const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 300_000);
const q = query({ prompt: `Test Agent Bridge by delegating a real task to Codex. Use only Agent Bridge tools. First list_models with runtime codex. Choose its default model and low effort if supported, otherwise its reported default effort. Start exactly one NEW review conversation with runtime codex, cwd ${JSON.stringify(cwd)}, requestKey host-review, timeoutSeconds 180. Prompt Codex to read marker.txt and return its exact contents without edits. Wait for completion, using nextCursor. Then start a FOLLOW-UP on that conversation, requestKey host-followup, asking Codex to repeat that marker from conversation memory without tools. Wait for completion. Report both run IDs, native ID and the remembered marker. Do not invent results or finish while a job is pending.`, options: {
  pathToClaudeCodeExecutable: settings.executable, cwd, model: 'claude-opus-5-5', effort: 'high', maxTurns: 30,
  tools: [], settingSources: [], strictMcpConfig: true,
  mcpServers: { 'agent-bridge': { type: 'stdio', command: process.execPath, args: [resolve('dist/cli.js'), 'mcp'],
    env: { AGENT_BRIDGE_HOME: state, AGENT_BRIDGE_CODEX_PATH: settings.codexExecutable ?? '', AGENT_BRIDGE_CLAUDE_PATH: settings.executable } } },
  abortController: abort, persistSession: false, permissionMode: 'default',
  canUseTool: async (tool, input) => allowed.includes(tool) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Acceptance host may use only Bridge lifecycle/read tools.' },
} });
console.log(JSON.stringify({ root, host: 'claude-opus-5-5' }));
try {
  for await (const event of q) {
    if (event.type === 'assistant') for (const block of event.message.content) if (block.type === 'tool_use') { calls.push({ name: block.name, input: block.input }); console.log(JSON.stringify({ tool: block.name })); }
    if (event.type === 'result') result = event;
  }
  assert.equal(result?.is_error, false, JSON.stringify(result));
  const store = new Store(state);
  try {
    const runs = store.listRuns(); assert.equal(runs.length, 2);
    assert.ok(runs.every(r => r.status === 'succeeded' && r.result?.includes(marker)));
    assert.equal(new Set(runs.map(r => r.conversationId)).size, 1);
    const conversation = store.getConversation(runs[0]!.conversationId); assert.equal(conversation.runtime, 'codex'); assert.ok(conversation.nativeId);
    writeFileSync(join(root, 'evidence.json'), JSON.stringify({ passed: true, platform: process.platform, hostModel: 'claude-opus-5-5', calls, runs: runs.map(r => ({ id: r.id, status: r.status, result: r.result })), nativeId: conversation.nativeId }, null, 2));
    console.log(JSON.stringify({ passed: true, root, nativeId: conversation.nativeId }));
  } finally { store.close(); }
} finally { clearTimeout(timer); q.close(); }
