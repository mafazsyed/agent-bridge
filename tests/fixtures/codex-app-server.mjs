import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const [scenario, record] = process.argv.slice(2);
const threadId = 'native-thread'; const turnId = 'native-turn';
let next = 1000; const requests = new Map();
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const notify = (method, params) => send({ method, params });
const reply = (m, result) => send({ id: m.id, result });
const ask = (method, params) => new Promise(resolve => { const id = ++next; requests.set(id, resolve); send({ id, method, params }); });
const model = { id: 'native-model', model: 'native-model', displayName: 'Fixture', description: 'Fixture', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }, { reasoningEffort: 'low', description: 'Low' }] };
const complete = (status = 'completed') => {
  notify('item/completed', { threadId, turnId, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'native result' } });
  notify('turn/completed', { threadId, turn: { id: turnId, status, items: [] } });
};
createInterface({ input: process.stdin }).on('line', async line => {
  const m = JSON.parse(line); appendFileSync(record, line + '\n');
  if (!m.method) { requests.get(m.id)?.(m.result ?? m.error); requests.delete(m.id); return; }
  switch (m.method) {
    case 'configRequirements/read': send({ id: m.id, error: { code: -32601, message: 'Localized unsupported request' } }); break;
    case 'initialize': if (scenario === 'startup-hang') break; reply(m, { userAgent: 'fixture/1' }); break;
    case 'account/read': reply(m, { account: scenario === 'signed-out' ? null : { type: 'chatgpt' }, requiresOpenaiAuth: true }); break;
    case 'config/read': reply(m, { config: { model: 'native-model', model_reasoning_effort: 'high',
      features: { apps: false, plugins: false, hooks: false, memories: false, multi_agent: false, multi_agent_v2: false, request_permissions_tool: false, code_mode: { enabled: false }, remote_control: false, js_repl: false, browser_use: false, computer_use: false, remote_plugin: false, plugin_hooks: false, skill_search: false, skill_mcp_dependency_install: false },
      skills: { bundled: { enabled: false }, include_instructions: false }, web_search: 'disabled',
      mcp_servers: { 'bridge.with.dot': { command: 'must-not-start' } } } }); break;
    case 'model/list': reply(m, { data: m.params.cursor ? [] : [model], nextCursor: m.params.cursor ? null : 'page2' }); break;
    case 'thread/start': case 'thread/resume': {
      if (scenario === 'before-dispatch-crash') { process.exit(1); break; }
      const write = m.params.sandbox === 'workspace-write';
      reply(m, { thread: { id: scenario === 'wrong-resume' ? 'other-thread' : threadId }, model: m.params.model,
        reasoningEffort: m.params.config.model_reasoning_effort, cwd: m.params.cwd, approvalPolicy: scenario === 'policy-downgrade' ? 'never' : m.params.approvalPolicy, approvalsReviewer: scenario === 'reviewer-downgrade' ? 'user' : m.params.approvalsReviewer,
        sandbox: scenario === 'unsafe' || m.params.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' } : write ? { type: 'workspaceWrite', writableRoots: [m.params.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } : { type: 'readOnly', networkAccess: false } }); break;
    }
    case 'mcpServerStatus/list': reply(m, { data: [{ name: 'bridge.with.dot', runtimeStatus: scenario === 'mcp-enabled' ? 'ready' : 'disabled' }], nextCursor: null }); break;
    case 'turn/start': {
      if (scenario === 'after-dispatch-crash') { process.exit(1); break; }
      if (scenario === 'invalid-json') { process.stdout.write('not JSON\n'); break; }
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
      if (scenario === 'early-complete') { complete(); reply(m, { turn: { id: turnId } }); break; }
      reply(m, { turn: { id: turnId } });
      if (scenario === 'cancel' || scenario === 'stuck-cancel') {
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
        appendFileSync(record, JSON.stringify({ grandchild: child.pid }) + '\n'); break;
      }
      if (scenario === 'approval' || scenario === 'foreign-approval' || scenario === 'resolved' || scenario === 'stdin-approval') {
        const params = { kind: scenario === 'stdin-approval' ? 'writeStdin' : 'command', threadId: scenario === 'foreign-approval' ? 'foreign' : threadId, turnId, itemId: 'cmd', command: 'echo fixture', cwd: m.params.cwd ?? process.cwd() };
        const answer = ask('item/commandExecution/requestApproval', params);
        if (scenario === 'resolved') setTimeout(() => notify('serverRequest/resolved', { threadId, requestId: next }), 80);
        appendFileSync(record, JSON.stringify({ decision: await answer }) + '\n');
      }
      if (['file', 'patch-updated', 'empty-patch', 'patch-pending'].includes(scenario)) {
        notify('item/started', { threadId, turnId, item: { id: 'patch', type: 'fileChange', changes: scenario === 'empty-patch' ? [] : [{ path: 'file.txt', diff: '+hello' }] } });
        if (scenario === 'patch-updated') notify('item/fileChange/patchUpdated', { threadId, turnId, itemId: 'patch', changes: [{ path: 'new.txt', diff: '+updated' }] });
        const requested = ask('item/fileChange/requestApproval', { threadId, turnId, itemId: 'patch' });
        if (scenario === 'patch-pending') setTimeout(() => notify('item/fileChange/patchUpdated', { threadId, turnId, itemId: 'patch', changes: [{ path: 'changed.txt', diff: '+not approved' }] }), 80);
        const answer = await requested;
        appendFileSync(record, JSON.stringify({ fileDecision: answer }) + '\n');
      }
      if (scenario === 'question') {
        const answer = await ask('item/tool/requestUserInput', { threadId, turnId, itemId: 'question', questions: [{ id: 'colour', question: 'Which colour?', header: 'Colour', isSecret: false, options: null }] });
        appendFileSync(record, JSON.stringify({ questionAnswer: answer }) + '\n');
      }
      if (scenario === 'unknown-request') { const answer = await ask('future/request', {}); appendFileSync(record, JSON.stringify({ unknownAnswer: answer }) + '\n'); }
      complete(); break;
    }
    case 'turn/interrupt': reply(m, {}); if (scenario !== 'stuck-cancel') complete('interrupted'); break;
  }
});
