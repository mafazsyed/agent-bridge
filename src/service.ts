import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { captureWorkspace } from './checkpoint.js';
import { recovery, summarizeEvents } from './progress.js';
import { Store, type CreateRunInput } from './store.js';
import { BridgeError, CLAUDE_EFFORTS, NATIVE_DEFAULT, RUNTIMES, TERMINAL, isClaudeEffort, type Conversation, type Run, type Runtime, type StartInput, type ForkInput, type SteeringRequest } from './types.js';
import type { Config } from './config.js';
import { resolveBase, forkBase } from './git.js';
import { workerAlive } from './process-identity.js';
import { runtimePermissionsSchema, validatePermissions } from './permission-options.js';

// The parsed input is the idempotency fingerprint: keep existing keys in order, append new optional keys
// without defaults, so requests that omit them hash exactly as before.
export const startSchema = z.object({
  requestKey: z.string().min(1).max(200), prompt: z.string().min(1).max(100_000),
  conversationId: z.string().uuid().optional(), cwd: z.string().min(1).max(4096).optional(),
  mode: z.enum(['review', 'write']).optional(), model: z.string().min(1).max(150).optional(),
  effort: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(), baseRef: z.string().min(1).max(200).optional(),
  timeoutSeconds: z.number().int().min(10).max(7200).optional(), maxTurns: z.number().int().min(1).max(100).optional(),
  acknowledgeUncertain: z.boolean().optional(), runtime: z.enum(RUNTIMES).optional(),
  permissions: runtimePermissionsSchema.nullable().optional(),
}).strict();
export const steerSchema = startSchema.pick({ requestKey: true, prompt: true }).extend({ runId: z.string().uuid() }).strict();
export const forkSchema = startSchema.pick({
  requestKey: true, prompt: true, model: true, effort: true, permissions: true, timeoutSeconds: true, maxTurns: true,
}).extend({ sourceConversationId: z.string().uuid() }).strict();
export const handoffSchema = z.object({
  runId: z.string().uuid(), summary: z.string().min(1).max(4000),
  unfinishedWork: z.array(z.string().min(1).max(2000)).max(30).default([]),
  checks: z.array(z.object({ description: z.string().min(1).max(1000), result: z.enum(['passed', 'failed', 'not_run', 'unknown']), evidenceSeq: z.number().int().positive().optional() }).strict()).max(30).default([]),
}).strict();
const DEFAULT_MAX_TURNS = 30;
const executableFor = (settings: Config, runtime: Runtime) => runtime === 'codex' ? settings.codexExecutable : settings.executable;
// A delegated runtime sets this for its children, so a delegated agent cannot fan out further delegations.
export function delegationDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_BRIDGE_DELEGATION_DEPTH?.trim();
  if (!raw) return 0;
  const depth = Number(raw);
  return Number.isFinite(depth) && depth >= 0 ? depth : Infinity;
}
export function requireTopLevel() {
  if (delegationDepth() > 0) throw new BridgeError('delegation_loop', 'Delegated workers cannot mutate Agent Bridge jobs or approvals.');
}
export function workerEnv(settings: Config, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base, AGENT_BRIDGE_HOME: settings.stateDir, AGENT_BRIDGE_CLAUDE_PATH: settings.executable,
    ...(settings.codexExecutable ? { AGENT_BRIDGE_CODEX_PATH: settings.codexExecutable } : {}),
    AGENT_BRIDGE_MAX_ACTIVE: String(settings.maxActive),
    // start() refuses nested delegation, so a launched worker is always the first level; its runtime children inherit this.
    AGENT_BRIDGE_DELEGATION_DEPTH: '1',
  };
}
export function publicRun(run: Run) {
  const { workerToken: _token, workerIdentity: _identity, fingerprint: _fingerprint, prompt: _prompt, ...visible } = run;
  return visible;
}
function steeringReceipt({ prompt: _prompt, ...receipt }: SteeringRequest) { return receipt; }
type Launcher = (run: Run, token: string) => void;
export class Bridge {
  readonly store: Store;
  constructor(readonly settings: Config, private launcher?: Launcher) {
    this.store = new Store(settings.stateDir);
  }
  close() { this.store.close(); }
  start(raw: StartInput) {
    const input = startSchema.parse(raw);
    requireTopLevel();
    this.reconcile();
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior = this.store.findByRequestKey(input.requestKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new BridgeError('idempotency_conflict', 'This requestKey already belongs to different input.');
      return { run: publicRun(prior), conversation: this.store.getConversation(prior.conversationId), created: false };
    }
    const saved = input.conversationId ? this.store.getConversation(input.conversationId) : null;
    if (saved && input.runtime !== undefined && input.runtime !== saved.runtime) {
      throw new BridgeError('immutable_conversation', `A follow-up continues its saved ${saved.runtime} conversation. Omit runtime or start a new conversation.`);
    }
    const runtime = saved?.runtime ?? input.runtime ?? 'claude';
    const permissions = input.permissions === undefined ? saved?.permissions ?? null : input.permissions;
    validatePermissions(permissions, runtime, saved?.mode ?? input.mode ?? 'review');
    if (!executableFor(this.settings, runtime)) {
      throw new BridgeError('cli_missing', runtime === 'codex'
        ? 'Install Codex and run codex login (or set AGENT_BRIDGE_CODEX_PATH) before starting a new Codex run. Saved work remains available.'
        : 'Install Claude Code and run claude auth login before starting a new run. Saved work remains available.');
    }
    if (runtime === 'claude' && input.effort !== undefined && !isClaudeEffort(input.effort)) {
      throw new BridgeError('invalid_effort', `Claude effort must be one of ${CLAUDE_EFFORTS.join(', ')}.`);
    }
    // Codex runs one native turn per run, bounded by timeoutSeconds; it has no turn limit to honour.
    if (runtime === 'codex' && input.maxTurns !== undefined) {
      throw new BridgeError('unsupported_option', 'maxTurns is not supported for Codex runs; use timeoutSeconds to bound a run.');
    }
    let conversation: Conversation;
    if (saved) {
      conversation = saved;
      if (input.cwd !== undefined || input.mode !== undefined || input.baseRef !== undefined) {
        throw new BridgeError('immutable_conversation', 'A follow-up uses its saved workspace and mode. Omit cwd, mode and baseRef.');
      }
    } else {
      if (!input.cwd) throw new BridgeError('cwd_required', 'A new conversation requires an explicit workspace directory.');
      if (!isAbsolute(input.cwd)) throw new BridgeError('absolute_cwd_required', 'cwd must be an absolute path to the intended workspace.');
      const source = realpathSync.native(input.cwd);
      if (!statSync(source).isDirectory()) throw new BridgeError('invalid_workspace', 'cwd must be a directory');
      const id = randomUUID();
      const mode = input.mode ?? 'review';
      if (mode === 'write' && !input.baseRef) throw new BridgeError('base_required', 'Write mode requires an explicit baseRef; uncommitted changes are not copied.');
      const base = mode === 'write' ? resolveBase(source, input.baseRef!) : null;
      const defaults = runtime === 'codex' ? { model: NATIVE_DEFAULT, effort: NATIVE_DEFAULT } : { model: 'claude-opus-5-5', effort: 'high' };
      conversation = {
        id, runtime, permissions, nativeId: null, cwd: mode === 'write' ? join(realpathSync.native(this.settings.stateDir), 'worktrees', id) : source,
        sourceCwd: base?.repo ?? source, mode, model: input.model ?? defaults.model, effort: input.effort ?? defaults.effort,
        baseCommit: base?.commit ?? null, branch: mode === 'write' ? `agent-bridge/${id}` : null,
        sessionInitialized: false, createdAt: Date.now(),
      };
    }
    // Codex ignores maxTurns; the stored default only satisfies the ledger column.
    return this.submit({
      conversation, requestKey: input.requestKey, fingerprint, prompt: input.prompt,
      model: input.model ?? conversation.model, effort: input.effort ?? conversation.effort,
      permissions,
      timeoutMs: (input.timeoutSeconds ?? 1800) * 1000, maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
      acknowledgeUncertain: input.acknowledgeUncertain,
    });
  }
  fork(raw: ForkInput) {
    const input = forkSchema.parse(raw);
    requireTopLevel();
    this.reconcile();
    // Separate operation namespace, while preserving all existing start fingerprints.
    const fingerprint = createHash('sha256').update(`fork:${JSON.stringify(input)}`).digest('hex');
    const prior = this.store.findByRequestKey(input.requestKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new BridgeError('idempotency_conflict', 'This requestKey already belongs to different input.');
      return { run: publicRun(prior), conversation: this.store.getConversation(prior.conversationId), created: false };
    }
    const { conversation: source, run: checkpoint } = this.store.forkSource(input.sourceConversationId);
    const permissions = input.permissions === undefined ? source.permissions ?? null : input.permissions;
    validatePermissions(permissions, source.runtime, source.mode);
    if (!executableFor(this.settings, source.runtime)) throw new BridgeError('cli_missing', `Install and sign in to the native ${source.runtime} CLI before forking.`);
    if (source.runtime === 'claude' && input.effort !== undefined && !isClaudeEffort(input.effort)) throw new BridgeError('invalid_effort', `Claude effort must be one of ${CLAUDE_EFFORTS.join(', ')}.`);
    if (source.runtime === 'codex' && input.maxTurns !== undefined) throw new BridgeError('unsupported_option', 'maxTurns is not supported for Codex; use timeoutSeconds.');
    const id = randomUUID();
    const base = source.mode === 'write' ? forkBase(source.cwd, undefined, source.branch) : null;
    const conversation: Conversation = {
      ...source, id, nativeId: null, sessionInitialized: false, createdAt: Date.now(),
      fork: { conversationId: source.id, runId: checkpoint.id, nativeId: source.nativeId ?? source.id, cwd: source.cwd, branch: source.branch,
        sourceBaseCommit: source.fork?.sourceBaseCommit ?? source.baseCommit, turnId: this.store.nativeTurnId(checkpoint.id) },
      permissions, model: input.model ?? source.model, effort: input.effort ?? source.effort,
      cwd: base ? join(realpathSync.native(this.settings.stateDir), 'worktrees', id) : source.cwd,
      sourceCwd: source.sourceCwd, baseCommit: base?.commit ?? null, branch: base ? `agent-bridge/${id}` : null,
    };
    return this.submit({
      conversation, requestKey: input.requestKey, fingerprint, prompt: input.prompt,
      model: conversation.model, effort: conversation.effort, permissions,
      timeoutMs: (input.timeoutSeconds ?? 1800) * 1000, maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
    });
  }
  private submit(input: CreateRunInput) {
    const created = this.store.createRun(input);
    if (created.created) {
      const token = randomUUID();
      try {
        if (this.launcher) this.launcher(created.run, token);
        else this.launch(created.run, token);
      } catch (error) {
        this.store.finishRun(created.run.id, null, 'failed', String(error), 'worker_start_failed');
        throw error;
      }
    }
    return { run: publicRun(this.store.getRun(created.run.id)), conversation: created.conversation, created: created.created };
  }
  private launch(run: Run, token: string) {
    const worker = fileURLToPath(new URL('./worker.js', import.meta.url));
    const child = spawn(process.execPath, [worker, this.settings.stateDir, run.id, token], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: workerEnv(this.settings),
    });
    child.on('error', () => {
      // Open a separate connection: the originating stdio MCP host may have closed.
      const store = new Store(this.settings.stateDir);
      try { store.finishRun(run.id, null, 'failed', 'Unable to start detached worker', 'worker_start_failed'); } finally { store.close(); }
    });
    child.unref();
  }
  reconcile() { return this.store.reconcile(Date.now() - this.settings.staleMs, workerAlive); }
  steer(raw: z.input<typeof steerSchema>) {
    requireTopLevel();
    const input = steerSchema.parse(raw);
    this.reconcile();
    return steeringReceipt(this.store.requestSteering(input));
  }
  get(runId: string, afterSeq = 0) {
    this.reconcile();
    const run = this.store.getRun(runId);
    const events = this.store.events(runId, afterSeq, 50);
    return { run: publicRun(run), recovery: this.recovery(run), conversation: this.store.getConversation(run.conversationId), permissions: this.store.pendingPermissions(runId), steering: this.store.recentSteering(runId).map(steeringReceipt), events, nextCursor: events.at(-1)?.seq ?? afterSeq, mayHaveMore: events.length === 50 };
  }
  private recovery(run: Run) {
    return recovery(run, undefined, undefined, this.store.activeConversationRuns(run.conversationId, run.id).map(r => r.id));
  }
  progress(runId: string) {
    this.reconcile();
    const run = this.store.getRun(runId), c = this.store.getConversation(run.conversationId);
    const recent = this.store.recentEvents(runId, 12);
    return { runId, conversationId: c.id, runtime: c.runtime, model: run.model, effort: run.effort, status: run.status,
      steeringOpen: run.steeringOpen, steering: this.store.recentSteering(runId).map(steeringReceipt),
      recovery: this.recovery(run), workspace: run.checkpoint ?? null, handoff: run.handoff ?? null,
      pendingInputs: this.store.pendingPermissions(runId).map(p => ({ id: p.id, tool: p.tool, reason: p.reason })),
      activity: summarizeEvents(recent), history: { tool: 'get_transcript', runId, afterSeq: 0 },
      result: run.result ? { preview: run.result.slice(0, 1000), truncated: run.result.length > 1000, tool: 'get_run', runId } : null,
      note: 'Activity is recorded evidence; agent/host reports are claims. A command exit code alone does not verify task correctness. Workspace is a timestamped observation, not a lock or a diff of only this run.' };
  }
  transcript(runId: string, afterSeq = 0, limit = 50) {
    this.store.getRun(runId);
    limit = Math.min(100, Math.max(1, limit));
    const events = this.store.transcript(runId, afterSeq, limit + 1);
    const mayHaveMore = events.length > limit;
    if (mayHaveMore) events.pop();
    return { runId, events, nextCursor: events.at(-1)?.seq ?? afterSeq, mayHaveMore,
      note: 'Message revisions share messageKey; replace their earlier presentation. Raw event evidence remains in get_run. Pruned history is unavailable.' };
  }
  async checkpoint(runId: string) {
    requireTopLevel();
    const run = this.store.getRun(runId);
    const captured = await captureWorkspace(this.store.getConversation(run.conversationId).cwd);
    this.store.recordCheckpoint(runId, captured);
    return { workspace: captured, recovery: this.recovery(this.store.getRun(runId)) };
  }
  handoff(raw: z.input<typeof handoffSchema>) {
    requireTopLevel();
    const { runId, ...note } = handoffSchema.parse(raw);
    this.store.recordHandoff(runId, { ...note, recordedAt: Date.now(), source: 'host_reported' });
    return this.progress(runId);
  }
  async wait(runId: string, afterSeq = 0, seconds = 30) {
    const end = Date.now() + Math.min(50, Math.max(0, seconds)) * 1000;
    do {
      const snapshot = this.get(runId, afterSeq);
      if (TERMINAL.includes(snapshot.run.status) || snapshot.run.status === 'needs_input' || snapshot.events.length || Date.now() >= end) return snapshot;
      await delay(250);
    } while (true);
  }
}
