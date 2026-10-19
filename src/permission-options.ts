import { z } from 'zod';
import { BridgeError, type Mode, type Runtime } from './types.js';

export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'] as const;
export const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const;
export const CODEX_REVIEWERS = ['user', 'auto_review'] as const;
export const granularApprovalSchema = z.object({ granular: z.object({
  sandbox_approval: z.boolean(), rules: z.boolean(), skill_approval: z.boolean(),
  request_permissions: z.boolean(), mcp_elicitations: z.boolean(),
}).strict() }).strict();
export const runtimePermissionsSchema = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('claude'), permissionMode: z.enum(CLAUDE_PERMISSION_MODES) }).strict(),
  z.object({ runtime: z.literal('codex'), sandbox: z.enum(CODEX_SANDBOXES),
    approvalPolicy: z.union([z.enum(CODEX_APPROVAL_POLICIES), granularApprovalSchema]),
    approvalsReviewer: z.enum(CODEX_REVIEWERS),
  }).strict(),
]);
export type RuntimePermissions = z.infer<typeof runtimePermissionsSchema>;
export type ClaudePermissions = Extract<RuntimePermissions, { runtime: 'claude' }>;
export type CodexPermissionOptions = Extract<RuntimePermissions, { runtime: 'codex' }>;

export function validatePermissions(permissions: RuntimePermissions | null | undefined, runtime: Runtime, mode: Mode) {
  if (!permissions) return;
  if (permissions.runtime !== runtime) throw new BridgeError('invalid_permissions', 'Permissions must belong to the selected runtime.');
  if (permissions.runtime === 'claude' && mode === 'review' && ['acceptEdits', 'auto', 'bypassPermissions'].includes(permissions.permissionMode)) {
    throw new BridgeError('invalid_permissions', 'Claude acceptEdits, auto and bypassPermissions require a write worktree. Review workspaces have no edit or command tools.');
  }
  if (runtime === 'codex' && mode === 'review' && permissions.runtime === 'codex' &&
      (permissions.sandbox !== 'read-only' || permissions.approvalPolicy !== 'never' || permissions.approvalsReviewer !== 'user')) {
    throw new BridgeError('invalid_permissions', 'Review workspaces require Codex read-only / never / user. Use a write worktree for other native permission settings.');
  }
}

export function codexPermissionOptions(mode: Mode, permissions?: RuntimePermissions | null): CodexPermissionOptions {
  validatePermissions(permissions, 'codex', mode);
  return permissions as CodexPermissionOptions | undefined | null ?? {
    runtime: 'codex', sandbox: mode === 'review' ? 'read-only' : 'workspace-write',
    approvalPolicy: mode === 'review' ? 'never' : 'on-request', approvalsReviewer: 'user',
  };
}
