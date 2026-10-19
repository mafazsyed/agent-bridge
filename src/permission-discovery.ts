import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';
import { BridgeError, type Runtime } from './types.js';
import { claudeOptions } from './claude-options.js';
import { CodexClient } from './codex-client.js';
import { CLAUDE_PERMISSION_MODES, CODEX_APPROVAL_POLICIES, CODEX_REVIEWERS, CODEX_SANDBOXES } from './permission-options.js';

const descriptions = {
  default: 'Native prompted permissions. Claude CLI may label this manual; its SDK reports default.',
  acceptEdits: 'Claude automatically accepts file edits; other unresolved actions can request approval.',
  plan: 'Plan without making changes. Bridge supplies only its review tools in this mode.',
  dontAsk: 'Unapproved actions are denied without asking. Questions requiring approval may also be denied.',
  auto: 'Claude uses its native automatic permission classifier, subject to account, model and organization availability.',
  bypassPermissions: 'Skip ordinary Claude permission checks. Shell commands can access resources outside the worktree.',
};
type ClaudeProbe = (input: Parameters<typeof query>[0]) => Pick<Query, 'initializationResult' | 'reinitialize' | 'setPermissionMode' | 'close'>;
export async function discoverClaudePermissions(settings: Config, { open = query, timeoutMs = 20_000 }: { open?: ClaudeProbe; timeoutMs?: number } = {}) {
  if (!settings.executable) throw new BridgeError('cli_missing', 'Install Claude Code before listing its permissions.');
  const cwd = await mkdtemp(join(tmpdir(), 'bridge-claude-permissions-'));
  const abort = new AbortController(); let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> { await hold; })();
  let runtime: ReturnType<ClaudeProbe> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    runtime = open({ prompt, options: { ...claudeOptions(settings), cwd, tools: [],
      permissionMode: 'default', allowDangerouslySkipPermissions: true, persistSession: false, abortController: abort,
      canUseTool: async () => ({ behavior: 'deny', message: 'Permission discovery cannot execute tools.' }),
    } });
    const q = runtime;
    const probe = async () => {
      const init = await q.initializationResult();
      const modes = [];
      for (const value of CLAUDE_PERMISSION_MODES) {
        if (abort.signal.aborted) throw new BridgeError('permission_discovery_timeout', 'Claude permission discovery timed out.');
        try {
          await q.setPermissionMode(value);
          const applied = (await q.reinitialize() as { current_permission_mode?: string }).current_permission_mode ?? null;
          modes.push({ value, description: descriptions[value], workspaceModes: ['acceptEdits', 'auto', 'bypassPermissions'].includes(value) ? ['write'] : ['review', 'write'], available: applied === value, applied,
            reason: applied === value ? null : 'The runtime did not confirm this mode.' });
        } catch (error) { modes.push({ value, description: descriptions[value], workspaceModes: ['acceptEdits', 'auto', 'bypassPermissions'].includes(value) ? ['write'] : ['review', 'write'], available: false, applied: null, reason: String(error).slice(0, 1000) }); }
      }
      return { runtime: 'claude' as const, source: 'claude-code-control' as const, version: init.claude_code_version ?? null,
        modes, defaultSelection: null, notes: [
          'A new conversation defaults to Bridge-controlled delegation. Omitted permissions on a follow-up inherit its conversation default; null resets that run to Bridge-controlled. Explicit native modes keep Bridge tool/path boundaries.',
          'Availability is checked without inference and is verified again for the selected model before each run. It does not guarantee account quota.',
        ] };
    };
    return await Promise.race([probe(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BridgeError('permission_discovery_timeout', 'Claude permission discovery timed out.')), timeoutMs); })]);
  } finally {
    clearTimeout(timer); release(); abort.abort(); try { await runtime?.close(); } catch { /* Preserve probe outcome. */ }
    await rm(cwd, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}

// Native schema is authoritative for protocol values. Unsupported aliases/new fields
// are reported without silently inventing an adapter mapping for them.
export function codexPermissionCatalogue(schema: any, requirements: any) {
  const defs = schema?.definitions;
  const strings = (value: any): string[] => Array.isArray(value?.enum) ? value.enum.filter((v: unknown) => typeof v === 'string') :
    (value?.oneOf ?? []).flatMap((v: any) => strings(v));
  const approval = strings(defs?.AskForApproval), sandboxes = strings(defs?.SandboxMode), reviewers = strings(defs?.ApprovalsReviewer);
  if (!approval.length || !sandboxes.length || !reviewers.length) throw new BridgeError('permission_discovery_failed', 'Codex permission schema is missing required native fields. Update the CLI.');
  const fields = (native: string[], adapter: readonly string[], allowed?: string[] | null) => native.map(value => ({
    value, supported: adapter.includes(value), allowedByRequirements: allowed == null ? null : allowed.includes(value),
  }));
  return { runtime: 'codex' as const, source: 'codex-generated-schema' as const,
    sandbox: fields(sandboxes, CODEX_SANDBOXES, requirements?.allowedSandboxModes),
    approvalPolicy: fields(approval, CODEX_APPROVAL_POLICIES, requirements?.allowedApprovalPolicies),
    approvalsReviewer: fields(reviewers, CODEX_REVIEWERS),
    granularApproval: defs.AskForApproval?.oneOf?.some((v: any) => v.properties?.granular) === true,
    requirements: requirements ?? null, defaultSelection: null,
    notes: [
      'Sandbox access, approval policy and reviewer are separate native controls. never does not mean full access.',
      'auto_review is Codex automatic approval review; it is not Claude auto. guardian_subagent is a legacy alias, not a separate selectable mode.',
      'Review workspaces require read-only / never / user. Other selections require a write worktree. Sandboxed modes keep network access disabled; danger-full-access removes that sandbox.',
      'Native execution rules still apply. External tools remain disabled. Effective settings are checked before every prompt; organization policy may refuse a selection.',
    ],
  };
}
export async function discoverCodexPermissions(settings: Config, { timeoutMs = 20_000,
  open = (exe: string, cwd: string) => new CodexClient(exe, cwd),
  generate = async (exe: string, cwd: string) => { await promisify(execFile)(exe, ['app-server', 'generate-json-schema', '--out', cwd, '--experimental'], { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }); },
} = {}) {
  if (!settings.codexExecutable) throw new BridgeError('cli_missing', 'Install Codex before listing its permissions.');
  const cwd = await mkdtemp(join(tmpdir(), 'bridge-codex-permissions-'));
  let client: CodexClient | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await generate(settings.codexExecutable, cwd);
    const schema = JSON.parse(await readFile(join(cwd, 'v2', 'ThreadStartParams.json'), 'utf8'));
    client = open(settings.codexExecutable, cwd); const c = client;
    const requirements = await Promise.race([(async () => { await c.initialize(); return c.request('configRequirements/read', undefined); })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BridgeError('permission_discovery_timeout', 'Codex permission discovery timed out.')), timeoutMs); })]);
    return codexPermissionCatalogue(schema, requirements.requirements);
  } finally { clearTimeout(timer); await client?.close(); await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {}); }
}

export function createPermissionDiscovery(settings: Config) {
  const pending = new Map<Runtime, Promise<unknown>>();
  return (runtime: Runtime): Promise<unknown> => {
    const current = pending.get(runtime); if (current) return current;
    const next = (runtime === 'codex' ? discoverCodexPermissions(settings) : discoverClaudePermissions(settings)).finally(() => { pending.delete(runtime); });
    pending.set(runtime, next); return next;
  };
}
