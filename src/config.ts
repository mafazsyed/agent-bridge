import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { BridgeError } from './types.js';

export interface Config { stateDir: string; executable: string; maxActive: number; staleMs: number }
export function config(requireRuntime = true): Config {
  const explicit = process.env.AGENT_BRIDGE_CLAUDE_PATH;
  const candidates = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean).map(p => join(p, process.platform === 'win32' ? 'claude.exe' : 'claude'));
  const executable = explicit ? resolve(explicit) : candidates.find(existsSync);
  if (!executable && requireRuntime) throw new BridgeError('cli_missing', 'Install Claude Code and run claude auth login, or set AGENT_BRIDGE_CLAUDE_PATH to its executable.');
  const maxActive = Number(process.env.AGENT_BRIDGE_MAX_ACTIVE ?? 1);
  if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 4) throw new BridgeError('invalid_config', 'AGENT_BRIDGE_MAX_ACTIVE must be 1–4.');
  return { stateDir: resolve(process.env.AGENT_BRIDGE_HOME ?? join(homedir(), '.agent-bridge')), executable: executable ?? '', maxActive, staleMs: 120_000 };
}
