#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { config } from './config.js';
import { Bridge, publicRun } from './service.js';
import { serve } from './mcp.js';
import { discoverModels } from './models.js';

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
    console.log('Agent Bridge\n  mcp                     Start stdio MCP server\n  models                  List Claude models and effort capabilities\n  start                   Read start_run JSON from stdin\n  get RUN_ID [CURSOR]      Read progress/results\n  wait RUN_ID [SECONDS] [CURSOR]  Wait for new progress (up to 50s)\n  cancel RUN_ID            Request cancellation\n  answer PERMISSION_ID    Read {decision, answers?} JSON from stdin\n  runs | conversations    List saved work\n  prune [DAYS]            Remove old task content; preserve receipts\n  doctor                  Check the local CLI and state directory\n\nRequires Node 24+ and authenticated Claude Code. See README for permissions and recovery.');
    return;
  }
  const settings = config(command === 'doctor' || command === 'models');
  if (command === 'models') {
    console.log(JSON.stringify(await discoverModels(settings), null, 2));
    return;
  }
  if (command === 'doctor') {
    const version = execFileSync(settings.executable, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
    console.log(JSON.stringify({ node: process.version, claude: version, executable: settings.executable, stateDir: settings.stateDir, maxActive: settings.maxActive, authentication: 'Not tested; run claude auth login if a delegated task reports auth_required.' }, null, 2));
    return;
  }
  const bridge = new Bridge(settings);
  if (command === 'mcp') { await serve(bridge); return; }
  try {
    let result: unknown;
    switch (command) {
      case 'start': result = bridge.start(JSON.parse(await input())); break;
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
        result = { prunedRuns: bridge.store.prune(Date.now() - days * 86_400_000), retained: 'Idempotency receipts, conversation identities and worktrees. Claude maintains its own session transcripts separately.' };
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
