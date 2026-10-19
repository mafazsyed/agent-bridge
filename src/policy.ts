import { realpathSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, basename, join, isAbsolute, sep } from 'node:path';
import type { Mode } from './types.js';

export const REVIEW_TOOLS = ['Read', 'Glob', 'Grep', 'AskUserQuestion'];
export const WRITE_TOOLS = [...REVIEW_TOOLS, 'Write', 'Edit', 'Bash'];
export function within(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`));
}
export function physicalPath(path: string): string {
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  if (parent === path) throw new Error('Cannot resolve workspace path');
  return join(physicalPath(parent), basename(path));
}
export type Decision = { kind: 'allow' | 'ask' | 'deny'; reason: string };
export function evaluateTool(cwd: string, mode: Mode, tool: string, input: Record<string, unknown>): Decision {
  if (!(mode === 'review' ? REVIEW_TOOLS : WRITE_TOOLS).includes(tool)) return { kind: 'deny', reason: 'Tool is outside this run’s declared capabilities.' };
  if (tool === 'AskUserQuestion') return { kind: 'ask', reason: 'Claude needs an answer to continue.' };
  if (tool === 'Bash') return input.run_in_background === true ? { kind: 'deny', reason: 'Background commands are not supported.' } : { kind: 'ask', reason: 'Approve this exact command. Shell access is not confined by a Git worktree and can affect files or services outside it.' };
  const filter = tool === 'Glob' ? input.pattern : tool === 'Grep' ? input.glob : undefined;
  if (typeof filter === 'string' && (isAbsolute(filter) || filter.split(/[\\/{},]/).includes('..') || filter.split(/[\\/]/).some(part => /[{}]/.test(part) && (part.match(/\./g)?.length ?? 0) >= 2))) {
    return { kind: 'deny', reason: 'Search patterns must stay relative to the workspace.' };
  }
  const pathValue = ['Read', 'Write', 'Edit'].includes(tool) ? input.file_path : input.path ?? cwd;
  if (typeof pathValue !== 'string' || !pathValue) return { kind: 'deny', reason: 'Missing file or search path.' };
  try {
    cwd = realpathSync.native(cwd);
    const logical = resolve(cwd, pathValue);
    const physical = physicalPath(logical);
    if (!within(cwd, logical) || !within(cwd, physical)) return { kind: 'deny', reason: 'Path is outside this conversation’s workspace.' };
    const parts = relative(cwd, logical).split(sep);
    const realParts = relative(cwd, physical).split(sep);
    if (['Write', 'Edit'].includes(tool) && [...parts, ...realParts].some(p => ['.git', '.claude', '.codex', '.agents', '.mcp.json'].includes(p.toLowerCase().replace(/[ .]+$/, '')))) {
      return { kind: 'deny', reason: 'Direct edits to Git metadata and agent configuration are disabled.' };
    }
    return { kind: 'allow', reason: 'Workspace-scoped file operation.' };
  } catch { return { kind: 'deny', reason: 'Cannot verify the file path.' }; }
}
