#!/usr/bin/env node
// Protocol fixture only. It never invokes a model, reads credentials or executes tools.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const value = flag => args.find(arg => arg.startsWith(flag + '='))?.slice(flag.length + 1) ?? (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const session = (args.includes('--fork-session') ? value('--session-id') : value('--resume')) || value('--session-id') || randomUUID();
const model = value('--model');
let permissionMode = value('--permission-mode') ?? 'default';
let resultSent = false, inputEnded = false, flushOnEof = false, slowCancel = false;
const flush = () => {
  if (!flushOnEof || !resultSent || !inputEnded) return;
  setTimeout(() => {
    if (process.env.AGENT_BRIDGE_FIXTURE_TRACE) appendFileSync(process.env.AGENT_BRIDGE_FIXTURE_TRACE, JSON.stringify({ fixture: 'transcript_flushed', session }) + '\n');
    process.exit(0);
  }, 75);
};
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
const input = createInterface({ input: process.stdin });
input.on('close', () => { inputEnded = true; flush(); if (slowCancel) setTimeout(() => process.exit(0), 4000); });
if (process.env.AGENT_BRIDGE_FIXTURE_LOG) appendFileSync(process.env.AGENT_BRIDGE_FIXTURE_LOG, JSON.stringify({ pid: process.pid, session, args: args.filter((_, i) => args[i - 1] !== '--append-system-prompt') }) + '\n');
input.on('line', line => {
  const event = JSON.parse(line);
  if (process.env.AGENT_BRIDGE_FIXTURE_TRACE) appendFileSync(process.env.AGENT_BRIDGE_FIXTURE_TRACE, JSON.stringify(event) + '\n');
  if (event.type === 'control_request') {
    if (process.env.AGENT_BRIDGE_FIXTURE_INIT_HANG) return;
    if (event.request.subtype === 'get_usage') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: {
        rate_limits_available: true, rate_limits: { five_hour: { utilization: 25, resets_at: '2026-10-20T10:00:00Z' } },
        session: { secret: 'PRIVATE' }, behaviors: { secret: 'PRIVATE' },
      } } }); return;
    }
    if (event.request.subtype === 'set_permission_mode') permissionMode = event.request.mode;
    send({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { current_permission_mode: permissionMode, hooks_applied: true, commands: [], models: [{ value: 'fixture-alias', resolvedModel: 'fixture-model-1', displayName: 'Fixture model', description: 'Metadata only', supportsEffort: true, supportsAutoMode: true, supportedEffortLevels: ['low', 'high'] }], agents: [], account: { email: 'private-fixture@example.invalid', organization: 'private-fixture-org' } } } });
  }
  if (event.type !== 'user') return;
  const text = typeof event.message.content === 'string' ? event.message.content : JSON.stringify(event.message.content);
  flushOnEof = text.includes('fixture:flush');
  slowCancel = text.includes('fixture:slow-cancel');
  if (slowCancel) process.on('SIGTERM', () => {}); // Emulate the SDK's longer Windows EOF grace on every host.
  send({ type: 'system', subtype: 'init', session_id: session, model, ...(text.includes('fixture:effort') ? { effort: 'medium' } : {}), tools: [], mcp_servers: [], permissionMode, claude_code_version: '2.1.302', uuid: randomUUID() });
  if (text.includes('fixture:crash')) { setTimeout(() => process.exit(2), 100); return; }
  const done = () => {
    if (text.includes('fixture:frames')) {
      const frame = { type: 'assistant', session_id: session, parent_tool_use_id: null, uuid: randomUUID(), message: { id: 'same-message-id', role: 'assistant', content: [{ type: 'text', text: 'first block' }] } };
      send(frame); send(frame);
      send({ ...frame, uuid: randomUUID(), message: { ...frame.message, content: [{ type: 'text', text: 'second block' }] } });
      send({ ...frame, uuid: randomUUID() });
    }
    send({ type: 'result', subtype: 'success', session_id: text.includes('fixture:identity') ? randomUUID() : session, is_error: text.includes('fixture:allowance'), result: text.includes('fixture:allowance') ? "You've hit your session limit" : text.includes('fixture:delay') ? 'delayed fixture done' : 'fixture done', duration_ms: 100, duration_api_ms: 0, num_turns: 1, total_cost_usd: value('--resume') ? 0.2 : 0.1, modelUsage: {}, usage: { input_tokens: 12, output_tokens: 8 }, permission_denials: [], uuid: randomUUID() });
    resultSent = true;
    if (text.includes('fixture:flush-crash')) { setTimeout(() => process.exit(2), 20); return; }
    if (flushOnEof) { flush(); return; }
    setTimeout(() => process.exit(0), 30);
  };
  setTimeout(done, text.includes('fixture:hang') ? 120_000 : text.includes('fixture:delay') ? 1500 : 10);
});
