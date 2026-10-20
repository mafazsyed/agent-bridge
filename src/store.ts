import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { BridgeError, NATIVE_DEFAULT, QUESTION_TOOLS, TERMINAL, type Conversation, type Effort, type Event, type Permission, type Run, type RunStatus } from './types.js';
import { runtimePermissionsSchema, type RuntimePermissions } from './permission-options.js';
import type { ConcurrencyLimit } from './config.js';
import type { RunUsage } from './usage.js';

export interface CreateRunInput {
  permissions?: RuntimePermissions | null;
  conversation: Conversation;
  requestKey: string;
  fingerprint: string;
  prompt: string;
  model: string;
  effort: Effort;
  timeoutMs: number;
  maxTurns: number;
  acknowledgeUncertain?: boolean;
}

type Row = Record<string, unknown>;
type Param = string | number | null;

const ACTIVE = `status IN ('queued', 'running', 'needs_input')`;

const SCHEMA_VERSION = 5;
const RUNTIME_COLUMN = `runtime TEXT NOT NULL DEFAULT 'claude' CHECK (runtime IN ('claude', 'codex'))`;

// Private columns: ord gives deterministic insertion order, ack_unknown_through is the highest unknown
// run ord a request explicitly acknowledged, and consumed lets a worker take a decision at most once.
// Indexes on migrated columns are created by the migration, after those columns exist.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  ord INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ${RUNTIME_COLUMN},
  native_id TEXT,
  cwd TEXT NOT NULL,
  source_cwd TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('review', 'write')),
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  base_commit TEXT,
  branch TEXT,
  session_initialized INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  ord INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  request_key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'needs_input', 'succeeded', 'failed', 'cancelled', 'unknown')),
  timeout_ms INTEGER NOT NULL,
  max_turns INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  worker_token TEXT,
  worker_pid INTEGER,
  worker_identity TEXT,
  heartbeat_at INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error_code TEXT,
  ack_unknown_through INTEGER
);
CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id, created_at, ord);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
CREATE TABLE IF NOT EXISTS permissions (
  ord INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(id),
  tool TEXT NOT NULL,
  input TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'allow', 'deny', 'expired')),
  answers TEXT,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS permissions_one_pending ON permissions(run_id) WHERE decision = 'pending';
`;

const toConversation = (r: Row): Conversation => ({
  fork: r.fork_json == null ? null : JSON.parse(r.fork_json as string),
  permissions: r.permissions_json == null ? null : runtimePermissionsSchema.parse(JSON.parse(r.permissions_json as string)),
  id: r.id as string,
  runtime: r.runtime as Conversation['runtime'],
  nativeId: r.native_id as string | null,
  cwd: r.cwd as string,
  sourceCwd: r.source_cwd as string,
  mode: r.mode as Conversation['mode'],
  model: r.model as string,
  effort: r.effort as Effort,
  baseCommit: r.base_commit as string | null,
  branch: r.branch as string | null,
  sessionInitialized: r.session_initialized === 1,
  createdAt: r.created_at as number,
});

const toRun = (r: Row): Run => ({
  usage: r.usage_json == null ? null : JSON.parse(r.usage_json as string),
  permissions: r.permissions_json == null ? null : runtimePermissionsSchema.parse(JSON.parse(r.permissions_json as string)),
  id: r.id as string,
  conversationId: r.conversation_id as string,
  requestKey: r.request_key as string,
  fingerprint: r.fingerprint as string,
  prompt: r.prompt as string,
  model: r.model as string,
  effort: r.effort as Effort,
  status: r.status as RunStatus,
  timeoutMs: r.timeout_ms as number,
  maxTurns: r.max_turns as number,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
  startedAt: r.started_at as number | null,
  finishedAt: r.finished_at as number | null,
  workerToken: r.worker_token as string | null,
  workerPid: r.worker_pid as number | null,
  workerIdentity: r.worker_identity as string | null,
  heartbeatAt: r.heartbeat_at as number | null,
  cancelRequested: r.cancel_requested === 1,
  result: r.result as string | null,
  errorCode: r.error_code as string | null,
});

const toEvent = (r: Row): Event => ({
  seq: r.seq as number, runId: r.run_id as string, at: r.at as number, type: r.type as string, data: JSON.parse(r.data as string),
});

const toPermission = (r: Row): Permission => ({
  id: r.id as string,
  runId: r.run_id as string,
  tool: r.tool as string,
  input: JSON.parse(r.input as string),
  reason: r.reason as string,
  createdAt: r.created_at as number,
  expiresAt: r.expires_at as number,
  decision: r.decision as Permission['decision'],
  answers: r.answers === null ? null : JSON.parse(r.answers as string),
});

const isTerminal = (status: unknown) => TERMINAL.includes(status as RunStatus);
const limitOf = (n: number) => Math.max(0, Math.trunc(n));
const bounded = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export class Store {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly statements = new Map<string, StatementSync>();

  constructor(stateDir: string, now: () => number = Date.now) {
    this.now = now;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const file = join(stateDir, 'bridge.sqlite');
    // Create the file privately before SQLite opens it; WAL/SHM files inherit its mode.
    closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file, { timeout: 5000 });
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) > SCHEMA_VERSION) {
      this.db.close();
      throw new BridgeError('schema_too_new', 'This state directory was upgraded by a newer Agent Bridge. Use that version.');
    }
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.tx(() => this.db.exec(SCHEMA));
    // Each step is idempotent and runs under BEGIN IMMEDIATE, so concurrent openers migrate exactly once.
    // Version 1 conversations were all Claude sessions, which use the conversation ID as session ID (native_id NULL).
    this.tx(() => {
      const columns = this.all('PRAGMA table_info(runs)');
      if (!columns.some(c => c.name === 'worker_identity')) this.db.exec('ALTER TABLE runs ADD COLUMN worker_identity TEXT');
      if (!columns.some(c => c.name === 'permissions_json')) this.db.exec('ALTER TABLE runs ADD COLUMN permissions_json TEXT');
      if (!columns.some(c => c.name === 'usage_json')) this.db.exec('ALTER TABLE runs ADD COLUMN usage_json TEXT');
      const conversationColumns = this.all('PRAGMA table_info(conversations)');
      if (!conversationColumns.some(c => c.name === 'runtime')) this.db.exec(`ALTER TABLE conversations ADD COLUMN ${RUNTIME_COLUMN}`);
      if (!conversationColumns.some(c => c.name === 'native_id')) this.db.exec('ALTER TABLE conversations ADD COLUMN native_id TEXT');
      if (!conversationColumns.some(c => c.name === 'permissions_json')) this.db.exec('ALTER TABLE conversations ADD COLUMN permissions_json TEXT');
      if (!conversationColumns.some(c => c.name === 'fork_json')) this.db.exec('ALTER TABLE conversations ADD COLUMN fork_json TEXT');
      this.db.exec("CREATE INDEX IF NOT EXISTS conversations_fork_source ON conversations(json_extract(fork_json, '$.conversationId'))");
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS conversations_native ON conversations(runtime, native_id)');
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  prune(before: number): number {
    return this.tx(() => {
      const old = `status IN ('succeeded', 'failed', 'cancelled', 'unknown') AND finished_at < ?`;
      this.run(`DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE ${old})`, before);
      this.run(`UPDATE permissions SET input = '{}', answers = NULL WHERE run_id IN (SELECT id FROM runs WHERE ${old})`, before);
      // Keep tiny idempotency receipts and conversation identity to prevent accidental duplicate dispatch.
      return this.run(`UPDATE runs SET prompt = '[pruned]', result = NULL WHERE ${old} AND prompt <> '[pruned]'`, before);
    });
  }

  createRun(input: CreateRunInput): { run: Run; conversation: Conversation; created: boolean } {
    const now = this.now();
    return this.tx(() => {
      const prior = this.one('SELECT * FROM runs WHERE request_key = ?', input.requestKey);
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) {
          throw new BridgeError('idempotency_conflict', `Request key ${input.requestKey} was already used for a different request`);
        }
        const run = toRun(prior);
        return { run, conversation: this.getConversation(run.conversationId), created: false };
      }
      const c = input.conversation;
      let ackThrough: number | null = null;
      if (this.one('SELECT 1 FROM conversations WHERE id = ?', c.id)) {
        const saved = this.getConversation(c.id);
        if (saved.fork && !saved.sessionInitialized) throw new BridgeError('fork_not_ready', 'The fork has not bound its native history. Wait for its first run; if setup failed, inspect it and submit a new fork.');
        if (this.one(`SELECT 1 FROM conversations c JOIN runs r ON r.conversation_id = c.id
          WHERE json_extract(c.fork_json, '$.conversationId') = ? AND c.session_initialized = 0 AND r.${ACTIVE}`, c.id)) {
          throw new BridgeError('fork_in_progress', 'A fork is still copying this conversation. Wait for it to initialize or finish before continuing the source.');
        }
        const unacknowledged = this.one(
          `SELECT MAX(u.ord) AS ord FROM runs u WHERE u.conversation_id = ? AND u.status = 'unknown'
             AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.conversation_id = u.conversation_id AND a.ack_unknown_through >= u.ord)`,
          c.id,
        )?.ord as number | null;
        if (unacknowledged != null) {
          if (!input.acknowledgeUncertain) {
            throw new BridgeError('blocked_by_unknown', `Conversation ${c.id} has a run with unknown outcome; acknowledge the uncertainty to continue`);
          }
          ackThrough = unacknowledged;
        }
      } else {
        if (c.fork) this.assertForkCheckpoint(c);
        this.run(
          `INSERT INTO conversations (id, runtime, native_id, cwd, source_cwd, mode, model, effort, base_commit, branch, session_initialized, created_at, permissions_json, fork_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          c.id, c.runtime, c.nativeId, c.cwd, c.sourceCwd, c.mode, c.model, c.effort, c.baseCommit, c.branch, c.sessionInitialized ? 1 : 0, c.createdAt, c.permissions ? JSON.stringify(c.permissions) : null, c.fork ? JSON.stringify(c.fork) : null,
        );
      }
      const id = randomUUID();
      this.run(
        `INSERT INTO runs (id, conversation_id, request_key, fingerprint, prompt, model, effort, status, timeout_ms, max_turns,
           created_at, updated_at, ack_unknown_through, permissions_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
        id, c.id, input.requestKey, input.fingerprint, input.prompt, input.model, input.effort, input.timeoutMs, input.maxTurns,
        now, now, ackThrough, input.permissions ? JSON.stringify(input.permissions) : null,
      );
      return { run: this.getRun(id), conversation: this.getConversation(c.id), created: true };
    });
  }

  findByRequestKey(key: string): Run | null {
    const r = this.one('SELECT * FROM runs WHERE request_key = ?', key);
    return r ? toRun(r) : null;
  }

  getRun(id: string): Run {
    const r = this.one('SELECT * FROM runs WHERE id = ?', id);
    if (!r) throw new BridgeError('not_found', `Run ${id} not found`);
    return toRun(r);
  }

  getConversation(id: string): Conversation {
    const r = this.one('SELECT * FROM conversations WHERE id = ?', id);
    if (!r) throw new BridgeError('not_found', `Conversation ${id} not found`);
    return toConversation(r);
  }

  forkSource(id: string): { conversation: Conversation; run: Run } {
    return this.tx(() => this.forkSourceInside(id));
  }
  nativeTurnId(runId: string): string | null {
    const result = this.one("SELECT data FROM events WHERE run_id = ? AND type = 'result' ORDER BY seq DESC LIMIT 1", runId);
    const id = result ? JSON.parse(result.data as string).turnId : null;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  private forkSourceInside(id: string): { conversation: Conversation; run: Run } {
    const conversation = this.getConversation(id);
    if (this.one(`SELECT 1 FROM runs WHERE conversation_id = ? AND ${ACTIVE}`, id)) throw new BridgeError('fork_source_busy', 'Wait for all source runs to finish before forking.');
    const latest = this.one('SELECT * FROM runs WHERE conversation_id = ? ORDER BY ord DESC LIMIT 1', id);
    if (!conversation.sessionInitialized || !latest || latest.status !== 'succeeded') {
      throw new BridgeError('fork_source_not_ready', 'Forking requires a saved source whose latest run succeeded. Resolve interrupted or failed work in that conversation first.');
    }
    return { conversation, run: toRun(latest) };
  }

  private assertForkCheckpoint(child: Conversation) {
    const checkpoint = child.fork!;
    const source = this.forkSourceInside(checkpoint.conversationId);
    if (source.run.id !== checkpoint.runId || source.conversation.runtime !== child.runtime ||
        (source.conversation.nativeId ?? source.conversation.id) !== checkpoint.nativeId || source.conversation.cwd !== checkpoint.cwd) {
      throw new BridgeError('fork_source_changed', 'The source changed before its history could be forked. Submit a new fork.');
    }
  }

  checkForkLease(runId: string, token: string): void {
    this.tx(() => {
      const run = this.getRun(runId);
      if (run.workerToken !== token || run.status !== 'running' || run.cancelRequested) throw new BridgeError('cancelled', 'Fork no longer owns an uncancelled active run.');
      const child = this.getConversation(run.conversationId);
      if (child.fork && !child.sessionInitialized) this.assertForkCheckpoint(child);
    });
  }

  recordForkSnapshot(runId: string, token: string, snapshotTree: string): Conversation {
    if (!/^[a-f0-9]{40,64}$/.test(snapshotTree)) throw new BridgeError('invalid_argument', 'Invalid snapshot tree.');
    return this.tx(() => {
      const run = this.getRun(runId), child = this.getConversation(run.conversationId);
      if (run.workerToken !== token || run.status !== 'running' || run.cancelRequested) throw new BridgeError('cancelled', 'Fork no longer owns its active run.');
      if (!child.fork || child.sessionInitialized || child.fork.snapshotTree) throw new BridgeError('invalid_state', 'Fork snapshot is already fixed or not applicable.');
      this.assertForkCheckpoint(child);
      this.run('UPDATE conversations SET fork_json = ? WHERE id = ?', JSON.stringify({ ...child.fork, snapshotTree }), child.id);
      return this.getConversation(child.id);
    });
  }

  listRuns(limit = 30): Run[] {
    return this.all('SELECT * FROM runs ORDER BY created_at DESC, ord DESC LIMIT ?', limitOf(limit)).map(toRun);
  }

  listConversations(limit = 30): Conversation[] {
    return this.all('SELECT * FROM conversations ORDER BY created_at DESC, ord DESC LIMIT ?', limitOf(limit)).map(toConversation);
  }

  attachWorker(runId: string, token: string, pid: number, identity: string | null = null): boolean {
    const now = this.now();
    return this.run(
      `UPDATE runs SET worker_token = ?, worker_pid = ?, heartbeat_at = ?, updated_at = ?, worker_identity = ?
       WHERE id = ? AND status = 'queued' AND worker_token IS NULL`,
      token, pid, now, now, identity, runId,
    ) === 1;
  }

  heartbeat(runId: string, token: string): boolean {
    return this.run(`UPDATE runs SET heartbeat_at = ? WHERE id = ? AND worker_token = ? AND ${ACTIVE}`, this.now(), runId, token) === 1;
  }

  recordUsage(runId: string, token: string, usage: RunUsage): boolean {
    return this.run(`UPDATE runs SET usage_json = ? WHERE id = ? AND worker_token = ? AND status IN ('running', 'needs_input')`,
      JSON.stringify(usage), runId, token) === 1;
  }

  claimRun(runId: string, token: string, maxActive: ConcurrencyLimit = 1): boolean {
    if (maxActive !== 'unlimited' && (!Number.isSafeInteger(maxActive) || maxActive < 1)) throw new BridgeError('invalid_config', 'Invalid concurrency limit.');
    const now = this.now();
    return this.tx(() => {
      const r = this.one('SELECT * FROM runs WHERE id = ?', runId);
      if (!r || r.status !== 'queued' || r.worker_token !== token || r.cancel_requested === 1) return false;
      const conversationId = r.conversation_id as string, ord = r.ord as number;
      // An earlier unknown outcome blocks this run unless this run (or an earlier one) acknowledged it.
      const blocked = this.one(
        `SELECT 1 FROM runs u WHERE u.conversation_id = ? AND u.status = 'unknown' AND u.ord < ?
           AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.conversation_id = u.conversation_id
             AND a.ack_unknown_through >= u.ord AND a.ord <= ?)
         LIMIT 1`,
        conversationId, ord, ord,
      );
      if (blocked) {
        this.run(
          `UPDATE runs SET status = 'failed', error_code = 'blocked_by_unknown', finished_at = ?, updated_at = ? WHERE ord = ?`,
          now, now, ord,
        );
        return false;
      }
      const waiting = this.one(
        `SELECT 1 FROM runs WHERE conversation_id = ?
           AND (status IN ('running', 'needs_input') OR (status = 'queued' AND ord < ?))
         LIMIT 1`,
        conversationId, ord,
      );
      if (waiting) return false;
      const active = this.one(`SELECT COUNT(*) AS n FROM runs WHERE status IN ('running', 'needs_input')`)!.n as number;
      if (maxActive !== 'unlimited' && active >= maxActive) return false;
      this.run(`UPDATE runs SET status = 'running', started_at = ?, updated_at = ?, heartbeat_at = ? WHERE ord = ?`, now, now, now, ord);
      return true;
    });
  }

  markSessionInitialized(conversationId: string, runId?: string, token?: string): void {
    this.tx(() => {
      const child = this.getConversation(conversationId);
      if (child.fork) {
        if (!runId || !token) throw new BridgeError('lease_lost', 'Fork initialization requires its owning run.');
        const run = this.getRun(runId);
        if (run.conversationId !== conversationId || run.workerToken !== token || !['running', 'needs_input'].includes(run.status)) throw new BridgeError('lease_lost', 'Fork initialization requires its owning active run.');
        if (!child.sessionInitialized) this.assertForkCheckpoint(child);
      }
      this.run('UPDATE conversations SET session_initialized = 1 WHERE id = ?', conversationId);
    });
  }

  // Compare-and-swap the conversation's native session identity, fenced by the run lease. Rebinding the
  // same identity is idempotent; a different one is refused. Where this run asked for the native default,
  // record the model/effort the runtime actually applied (a null effort means it did not report one).
  bindNativeSession(runId: string, token: string, nativeId: string, model: string, effort: string | null): Conversation {
    if (!bounded(nativeId, 256)) throw new BridgeError('invalid_argument', 'Native session ID must be a nonempty string of at most 256 characters.');
    if (!bounded(model, 150)) throw new BridgeError('invalid_argument', 'Applied model must be a nonempty string of at most 150 characters.');
    if (effort !== null && !bounded(effort, 64)) throw new BridgeError('invalid_argument', 'Applied effort must be null or a nonempty string of at most 64 characters.');
    return this.tx(() => {
      const r = this.one(
        `SELECT r.status, r.worker_token, r.model, r.effort, c.id AS conversation_id, c.runtime, c.native_id, c.model AS conversation_model, c.effort AS conversation_effort
         FROM runs r JOIN conversations c ON c.id = r.conversation_id WHERE r.id = ?`,
        runId,
      );
      if (!r) throw new BridgeError('not_found', `Run ${runId} not found`);
      if (r.worker_token !== token || isTerminal(r.status)) throw new BridgeError('lease_lost', `Worker does not own active run ${runId}`);
      if (r.status === 'queued') throw new BridgeError('invalid_state', `Run ${runId} has not been claimed`);
      const conversationId = r.conversation_id as string;
      if (r.native_id !== null && r.native_id !== nativeId) {
        throw new BridgeError('session_identity_changed', 'Runtime returned a different native session; refusing silent replacement.');
      }
      if (this.one('SELECT 1 FROM conversations WHERE runtime = ? AND native_id = ? AND id <> ?', r.runtime as string, nativeId, conversationId)) {
        throw new BridgeError('session_identity_changed', 'Native session already belongs to another conversation.');
      }
      const runModel = r.model === NATIVE_DEFAULT ? model : r.model as string;
      const runEffort = r.effort === NATIVE_DEFAULT ? effort ?? NATIVE_DEFAULT : r.effort as string;
      const pin = (saved: unknown, requested: unknown, applied: string) => saved === NATIVE_DEFAULT && requested === NATIVE_DEFAULT ? applied : saved as string;
      this.run(
        `UPDATE conversations SET native_id = ?, session_initialized = 1, model = ?, effort = ? WHERE id = ? AND (native_id IS NULL OR native_id = ?)`,
        nativeId, pin(r.conversation_model, r.model, runModel), pin(r.conversation_effort, r.effort, runEffort), conversationId, nativeId,
      );
      this.run('UPDATE runs SET model = ?, effort = ?, updated_at = ? WHERE id = ? AND worker_token = ?', runModel, runEffort, this.now(), runId, token);
      return this.getConversation(conversationId);
    });
  }

  appendEvent(runId: string, type: string, data: unknown): Event {
    const now = this.now();
    const json = JSON.stringify(data) ?? 'null';
    const seq = this.tx(() => {
      if (!this.one('SELECT 1 FROM runs WHERE id = ?', runId)) throw new BridgeError('not_found', `Run ${runId} not found`);
      return Number(this.q('INSERT INTO events (run_id, at, type, data) VALUES (?, ?, ?, ?)').run(runId, now, type, json).lastInsertRowid);
    });
    return { seq, runId, at: now, type, data: JSON.parse(json) };
  }

  events(runId: string, afterSeq = 0, limit = 50): Event[] {
    return this.all('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?', runId, afterSeq, limitOf(limit)).map(toEvent);
  }

  requestCancel(runId: string): Run {
    const now = this.now();
    this.tx(() => {
      this.run(`UPDATE runs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND ${ACTIVE} AND cancel_requested = 0`, now, runId);
      this.run(`UPDATE runs SET status = 'cancelled', error_code = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND worker_token IS NULL`, now, now, runId);
    });
    return this.getRun(runId);
  }

  finishRun(
    runId: string,
    token: string | null,
    status: 'succeeded' | 'failed' | 'cancelled' | 'unknown',
    result: string | null = null,
    errorCode: string | null = null,
  ): boolean {
    if (!isTerminal(status)) throw new BridgeError('invalid_argument', `Status ${status} is not terminal`);
    const now = this.now();
    // A null token may only close a queued run no worker has attached to (startup failure).
    const owner = token === null ? `status = 'queued' AND worker_token IS NULL` : `worker_token = ? AND ${ACTIVE}`;
    return this.tx(() => {
      const changed = this.run(
        `UPDATE runs SET status = ?, result = ?, error_code = ?, finished_at = ?, updated_at = ? WHERE id = ? AND ${owner}`,
        status, result, errorCode, now, now, runId, ...(token === null ? [] : [token]),
      );
      if (changed === 0) return false;
      this.run(`UPDATE permissions SET decision = 'expired' WHERE run_id = ? AND decision = 'pending'`, runId);
      return true;
    });
  }

  reconcile(staleBefore: number, alive?: (run: Run) => boolean | undefined): number {
    const now = this.now();
    // Probe outside the write transaction. Re-check the lease inside it, so a returning heartbeat wins.
    const candidates = this.all(`SELECT * FROM runs WHERE ${ACTIVE} AND COALESCE(heartbeat_at, created_at) < ? ORDER BY ord LIMIT 100`, staleBefore)
      .map(toRun).filter(run => alive ? alive(run) === false : true);
    return this.tx(() => {
      let changed = 0;
      for (const run of candidates) {
        const neverStarted = run.status === 'queued';
        const count = this.run(`UPDATE runs SET status = ?, error_code = ?, finished_at = ?, updated_at = ? WHERE id = ? AND ${ACTIVE} AND COALESCE(heartbeat_at, created_at) < ? AND worker_token IS ?`, neverStarted ? 'failed' : 'unknown', neverStarted ? 'worker_start_lost' : 'worker_lost', now, now, run.id, staleBefore, run.workerToken);
        if (count) this.run(`UPDATE permissions SET decision = 'expired' WHERE decision = 'pending' AND run_id = ?`, run.id);
        changed += count;
      }
      return changed;
    });
  }

  requestPermission(runId: string, token: string, tool: string, input: Record<string, unknown>, reason: string, ttlMs = 300_000): Permission {
    const now = this.now();
    return this.tx(() => {
      const r = this.one('SELECT status, worker_token FROM runs WHERE id = ?', runId);
      if (!r) throw new BridgeError('not_found', `Run ${runId} not found`);
      if (r.worker_token !== token || isTerminal(r.status)) throw new BridgeError('lease_lost', `Worker does not own active run ${runId}`);
      if (r.status === 'needs_input') throw new BridgeError('permission_pending', `Run ${runId} already has an open permission request`);
      if (r.status !== 'running') throw new BridgeError('invalid_state', `Run ${runId} is ${r.status as string}, not running`);
      const id = randomUUID();
      this.run(
        `INSERT INTO permissions (id, run_id, tool, input, reason, created_at, expires_at, decision) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        id, runId, tool, JSON.stringify(input), reason, now, now + ttlMs,
      );
      this.run(`UPDATE runs SET status = 'needs_input', updated_at = ? WHERE id = ?`, now, runId);
      return this.getPermission(id);
    });
  }

  getPermission(id: string): Permission {
    const r = this.one('SELECT * FROM permissions WHERE id = ?', id);
    if (!r) throw new BridgeError('not_found', `Permission ${id} not found`);
    return toPermission(r);
  }

  pendingPermissions(runId: string): Permission[] {
    return this.all(`SELECT * FROM permissions WHERE run_id = ? AND decision = 'pending' ORDER BY created_at, ord`, runId).map(toPermission);
  }

  answerPermission(id: string, decision: 'allow' | 'deny', answers?: Record<string, string>): Permission {
    if (decision !== 'allow' && decision !== 'deny') throw new BridgeError('invalid_argument', `Invalid decision ${String(decision)}`);
    const now = this.now();
    const answered = this.tx(() => {
      const p = this.one('SELECT p.decision, p.expires_at, p.tool, p.input, r.status, r.cancel_requested FROM permissions p JOIN runs r ON r.id = p.run_id WHERE p.id = ?', id);
      if (!p) throw new BridgeError('not_found', `Permission ${id} not found`);
      if (p.decision !== 'pending') throw new BridgeError('permission_closed', `Permission ${id} is already ${p.decision as string}`);
      if (isTerminal(p.status)) throw new BridgeError('permission_closed', `Run for permission ${id} has finished`);
      if (p.cancel_requested === 1) throw new BridgeError('permission_closed', 'Cancellation was requested; this action cannot be approved.');
      if ((p.expires_at as number) <= now) {
        this.run(`UPDATE permissions SET decision = 'expired' WHERE id = ?`, id);
        return null;
      }
      if (decision === 'allow' && QUESTION_TOOLS.includes(p.tool as string)) {
        const questions = (JSON.parse(p.input as string).questions ?? []) as Array<{ question?: unknown }>;
        if (!answers || !Array.isArray(questions) || !questions.length || questions.some(q => typeof q?.question !== 'string' || typeof answers[q.question] !== 'string' || !answers[q.question]?.trim())) {
          throw new BridgeError('answers_required', 'Supply a nonempty answer for each exact question text.');
        }
      } else if (answers !== undefined) throw new BridgeError('invalid_argument', 'answers are only accepted when allowing a question.');
      this.run(`UPDATE permissions SET decision = ?, answers = ? WHERE id = ? AND decision = 'pending'`, decision, answers ? JSON.stringify(answers) : null, id);
      return this.getPermission(id);
    });
    if (!answered) throw new BridgeError('permission_expired', `Permission ${id} has expired`);
    return answered;
  }

  consumePermission(id: string, token: string): Permission | null {
    const now = this.now();
    return this.tx(() => {
      const p = this.one(
        'SELECT p.decision, p.expires_at, p.consumed, r.id AS run_id, r.status, r.worker_token, r.cancel_requested FROM permissions p JOIN runs r ON r.id = p.run_id WHERE p.id = ?',
        id,
      );
      if (!p) throw new BridgeError('not_found', `Permission ${id} not found`);
      if (p.worker_token !== token || isTerminal(p.status)) throw new BridgeError('lease_lost', `Worker does not own active run ${p.run_id as string}`);
      if (p.consumed === 1) throw new BridgeError('permission_consumed', `Permission ${id} was already consumed`);
      if (p.cancel_requested === 1 || (p.expires_at as number) <= now) {
        this.run(`UPDATE permissions SET decision = 'expired' WHERE id = ?`, id);
        p.decision = 'expired';
      }
      if (p.decision === 'pending') {
        if ((p.expires_at as number) > now) return null;
        this.run(`UPDATE permissions SET decision = 'expired' WHERE id = ?`, id);
      }
      this.run('UPDATE permissions SET consumed = 1 WHERE id = ?', id);
      this.run(`UPDATE runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'needs_input'`, now, p.run_id as string);
      return this.getPermission(id);
    });
  }

  // The native runtime resolved a request itself (e.g. it timed out or was withdrawn), so no answer can be
  // delivered. Expire a pending request and close it to consumption; resume the run only while it is still
  // active (and owned by token, when given). An already consumed request is returned unchanged.
  expirePermission(id: string, token?: string): Permission {
    const now = this.now();
    return this.tx(() => {
      const p = this.one('SELECT p.decision, p.consumed, r.id AS run_id, r.status, r.worker_token FROM permissions p JOIN runs r ON r.id = p.run_id WHERE p.id = ?', id);
      if (!p) throw new BridgeError('not_found', `Permission ${id} not found`);
      if (token !== undefined && (p.worker_token !== token || isTerminal(p.status))) throw new BridgeError('lease_lost', `Worker does not own active run ${p.run_id as string}`);
      if (p.consumed === 1) return this.getPermission(id);
      this.run(`UPDATE permissions SET decision = 'expired' WHERE id = ? AND decision = 'pending'`, id);
      this.run('UPDATE permissions SET consumed = 1 WHERE id = ?', id);
      this.run(`UPDATE runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'needs_input'`, now, p.run_id as string);
      return this.getPermission(id);
    });
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private q(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, statement = this.db.prepare(sql));
    return statement;
  }

  private one(sql: string, ...params: Param[]): Row | undefined {
    return this.q(sql).get(...params);
  }

  private all(sql: string, ...params: Param[]): Row[] {
    return this.q(sql).all(...params);
  }

  private run(sql: string, ...params: Param[]): number {
    return Number(this.q(sql).run(...params).changes);
  }
}
