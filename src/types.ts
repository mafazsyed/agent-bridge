export type Mode = 'review' | 'write';
export type Runtime = 'claude' | 'codex';
export const RUNTIMES = ['claude', 'codex'] as const satisfies readonly Runtime[];
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ClaudeEffort[];
export const isClaudeEffort = (effort: string): effort is ClaudeEffort => (CLAUDE_EFFORTS as readonly string[]).includes(effort);
// Claude levels are a fixed enum; Codex levels come from the native model catalogue.
export type Effort = string;
// Codex model/effort placeholder meaning "the native default"; replaced by the actual value once a session binds.
export const NATIVE_DEFAULT = 'default';
// Permission tools answered with { [exact question text]: answer }.
export const QUESTION_TOOLS: readonly string[] = ['AskUserQuestion', 'codex.userInput'];
export type RunStatus = 'queued' | 'running' | 'needs_input' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export const TERMINAL: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'unknown'];
export interface Conversation {
  id: string;
  runtime: Runtime;
  // Native session/thread identifier when it differs from id (Codex); null until bound, and for Claude.
  nativeId: string | null;
  cwd: string;
  sourceCwd: string;
  mode: Mode;
  model: string;
  effort: Effort;
  baseCommit: string | null;
  branch: string | null;
  sessionInitialized: boolean;
  createdAt: number;
}
export interface Run {
  id: string;
  conversationId: string;
  requestKey: string;
  fingerprint: string;
  prompt: string;
  model: string;
  effort: Effort;
  status: RunStatus;
  timeoutMs: number;
  maxTurns: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  workerToken: string | null;
  workerPid: number | null;
  workerIdentity: string | null;
  heartbeatAt: number | null;
  cancelRequested: boolean;
  result: string | null;
  errorCode: string | null;
}
export interface Event { seq: number; runId: string; at: number; type: string; data: unknown }
export interface Permission {
  id: string;
  runId: string;
  tool: string;
  input: Record<string, unknown>;
  reason: string;
  createdAt: number;
  expiresAt: number;
  decision: 'pending' | 'allow' | 'deny' | 'expired';
  answers: Record<string, string> | null;
}
export interface StartInput {
  requestKey: string;
  prompt: string;
  conversationId?: string;
  runtime?: Runtime;
  cwd?: string;
  mode?: Mode;
  model?: string;
  effort?: Effort;
  baseRef?: string;
  timeoutSeconds?: number;
  maxTurns?: number;
  acknowledgeUncertain?: boolean;
}
export class BridgeError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'BridgeError'; }
}
