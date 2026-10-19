export type Mode = 'review' | 'write';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type RunStatus = 'queued' | 'running' | 'needs_input' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export const TERMINAL: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'unknown'];
export interface Conversation {
  id: string;
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
