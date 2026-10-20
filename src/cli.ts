#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { config } from './config.js';
import { Bridge, publicRun, requireTopLevel } from './service.js';
import { serve } from './mcp.js';
import { discoverModels } from './models.js';
import { discoverCodexModels } from './codex-models.js';
import { BridgeError } from './types.js';
import { createPermissionDiscovery } from './permission-discovery.js';
import { discoverAccountLimits } from './limits.js';

async function input(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 120_000) throw new Error('Input exceeds 120 KB');
  }
  return text;
}
async function main() {
  const [command, arg, extra, cursor] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log('Agent Bridge\n  mcp                     Start stdio MCP server\n  models [claude|codex]    List native models and effort capabilities\n  permissions [claude|codex]  Discover native permission controls\n  limits [claude|codex]    Read current account quota without inference\n  start                   Read start_run JSON from stdin\n  fork                    Read fork_conversation JSON from stdin\n  get RUN_ID [CURSOR]      Read progress/results\n  wait RUN_ID [SECONDS] [CURSOR]  Wait for new progress (up to 50s)\n  cancel RUN_ID            Request cancellation\n  answer PERMISSION_ID    Read {decision, answers?} JSON from stdin\n  runs | conversations    List saved work\n  prune [DAYS]            Remove old task content; preserve receipts\n  doctor [claude|codex]    Check the native CLI and state directory\n\nRequires Node 24+ and authenticated Claude Code or Codex. See README for permissions and recovery.');
    return;
  }
  const settings = config(false);
  if (command === 'limits') {
    if (arg && !['claude', 'codex'].includes(arg)) throw new BridgeError('invalid_runtime', 'Runtime must be claude or codex.');
    console.log(JSON.stringify(await discoverAccountLimits(settings, arg === 'codex' ? 'codex' : 'claude'), null, 2));
    return;
  }
  if (command === 'permissions') {
    if (arg && !['claude', 'codex'].includes(arg)) throw new BridgeError('invalid_runtime', 'Runtime must be claude or codex.');
    console.log(JSON.stringify(await createPermissionDiscovery(settings)(arg === 'codex' ? 'codex' : 'claude'), null, 2));
    return;
  }
  if (command === 'models') {
    if (arg && !['claude', 'codex'].includes(arg)) throw new BridgeError('invalid_runtime', 'Runtime must be claude or codex.');
    console.log(JSON.stringify(await (arg === 'codex' ? discoverCodexModels(settings) : discoverModels(settings)), null, 2));
    return;
  }
  if (command === 'doctor') {
    if (arg && !['claude', 'codex'].includes(arg)) throw new BridgeError('invalid_runtime', 'Runtime must be claude or codex.');
    const runtime = arg ?? 'claude';
    const executable = runtime === 'codex' ? settings.codexExecutable : settings.executable;
    if (!executable) throw new BridgeError('cli_missing', `Install the native ${runtime} CLI.`);
    const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
    console.log(JSON.stringify({ node: process.version, runtime, version, executable, stateDir: settings.stateDir, maxActive: settings.maxActive, authentication: `Not tested; use ${runtime === 'claude' ? 'claude auth login' : 'codex login'} if a task reports auth_required.` }, null, 2));
    return;
  }
  if (['start', 'fork', 'cancel', 'answer', 'prune'].includes(command)) requireTopLevel();
  const bridge = new Bridge(settings);
  if (command === 'mcp') { await serve(bridge); return; }
  try {
    let result: unknown;
    switch (command) {
      case 'start': result = bridge.start(JSON.parse(await input())); break;
      case 'fork': result = bridge.fork(JSON.parse(await input())); break;
      case 'get': result = bridge.get(arg!, integer(extra ?? '0')); break;
      case 'wait': result = await bridge.wait(arg!, integer(cursor ?? '0'), integer(extra ?? '30')); break;
      case 'cancel': result = publicRun(bridge.store.requestCancel(arg!)); break;
      case 'answer': {
        const response = JSON.parse(await input());
        if (!['allow', 'deny'].includes(response.decision)) throw new Error('decision must be allow or deny');
        result = bridge.store.answerPermission(arg!, response.decision, response.answers); break;
      }
      case 'prune': {
        const days = Number(arg ?? 30);
        if (!Number.isFinite(days) || days < 1) throw new Error('Prune days must be at least 1');
        result = { prunedRuns: bridge.store.prune(Date.now() - days * 86_400_000), retained: 'Idempotency receipts, conversation identities and worktrees. Each runtime maintains its native session transcripts separately.' };
        break;
      }
      case 'runs': bridge.reconcile(); result = bridge.store.listRuns().map(publicRun); break;
      case 'conversations': result = bridge.store.listConversations(); break;
      default: throw new Error(`Unknown command: ${command}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { bridge.close(); }
}
function integer(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Expected a non-negative integer');
  return n;
}
main().catch(error => { console.error(JSON.stringify({ error: error.code ?? 'operation_failed', message: error.message })); process.exitCode = 1; });
