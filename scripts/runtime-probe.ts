import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';

if (process.env.AGENT_BRIDGE_LIVE !== '1') throw new Error('Set AGENT_BRIDGE_LIVE=1 to permit real model calls.');
const cwd = resolve(process.platform === 'win32' ? '.local/probe workspace' : '.local/probe workspace ');
await mkdir(cwd, { recursive: true });
const sessionId = randomUUID();
const marker = `orchid-${randomUUID()}`;
const executable = config().executable;
const model = 'claude-opus-5-5';
const common: Options = {
  cwd, pathToClaudeCodeExecutable: executable, model, effort: 'high', tools: [],
  settingSources: [], mcpServers: {}, strictMcpConfig: true,
  permissionMode: 'dontAsk', maxTurns: 2,
  extraArgs: { 'no-chrome': null, 'disable-slash-commands': null },
};
const evidence: Record<string, unknown>[] = [];
async function sdk(prompt: string, resume: boolean) {
  const q = query({ prompt, options: { ...common, ...(resume ? { resume: sessionId } : { sessionId }) } });
  let result: any;
  try {
    for await (const event of q) {
      if (event.type === 'system' && event.subtype === 'init') evidence.push({ phase: 'sdk-init', model: event.model, sessionId: event.session_id });
      if (event.type === 'result') result = event;
    }
  } finally { q.close(); }
  if (!result || result.is_error || result.session_id !== sessionId) throw new Error(`SDK failure: ${JSON.stringify(result)}`);
  evidence.push({ phase: resume ? 'sdk-resume' : 'sdk-start', sessionId: result.session_id, result: result.result, durationMs: result.duration_ms });
  return String(result.result);
}
await sdk(`Remember this exact marker for later: ${marker}. Reply only "stored".`, false);
const child = spawn(executable, ['-p', '--resume', sessionId, '--model', model, '--effort', 'high', '--output-format', 'json', '--tools', '', '--permission-mode', 'dontAsk', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--disable-slash-commands'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
let output = '', stderr = '';
child.stdout.on('data', c => output += c);
child.stderr.on('data', c => stderr += c);
child.stdin.end('What is the exact marker I gave you? Reply with only the marker.');
const exit = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
const cli = JSON.parse(output);
if (exit !== 0 || cli.is_error || cli.session_id !== sessionId || !cli.result.includes(marker)) throw new Error(`CLI compatibility failed: ${stderr} ${output}`);
evidence.push({ phase: 'cli-resume', sessionId: cli.session_id, result: cli.result });
const final = await sdk('What marker did you just repeat? Reply with only that marker.', true);
if (!final.includes(marker)) throw new Error('SDK lost context after CLI follow-up');
await writeFile('.local/runtime-probe.json', JSON.stringify({ passed: true, executable, model, effortRequested: 'high', cwd, evidence }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ passed: true, phases: evidence.map(x => x.phase), sessionId }));
