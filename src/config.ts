import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { BridgeError, type Runtime } from './types.js';

export type ConcurrencyLimit = number | 'unlimited';
export interface Config { stateDir: string; executable: string; codexExecutable?: string; maxActive: ConcurrencyLimit; staleMs: number }

export function parseConcurrency(raw = 'unlimited'): ConcurrencyLimit {
  raw = raw.trim().toLowerCase();
  if (raw === 'unlimited') return raw;
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new BridgeError('invalid_config', 'AGENT_BRIDGE_MAX_ACTIVE must be a positive safe integer or unlimited.');
  }
  return value;
}

const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
const pathDirs = (path: string | undefined, platform: NodeJS.Platform) => (path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
const WINDOWS_TRIPLES: Partial<Record<string, string>> = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' };

// npm installs Codex on Windows as a codex.cmd shim beside node_modules; the native codex.exe lives in the
// package's vendor tree or its optional platform package. Resolve that file directly instead of running the shim.
function npmCodexCandidates(dir: string, arch: string): string[] {
  const triple = WINDOWS_TRIPLES[arch];
  if (!triple || !existsSync(join(dir, 'codex.cmd'))) return [];
  const modules = join(dir, 'node_modules', '@openai');
  return [join(modules, 'codex'), join(modules, 'codex', 'node_modules', '@openai', `codex-win32-${arch}`), join(modules, `codex-win32-${arch}`)]
    .flatMap(pkg => ['bin', 'codex'].map(dir => join(pkg, 'vendor', triple, dir, 'codex.exe')));
}

export function discoverCodex(path = process.env.PATH, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  for (const dir of pathDirs(path, platform)) {
    const candidates = platform === 'win32' ? [join(dir, 'codex.exe'), ...npmCodexCandidates(dir, arch)] : [join(dir, 'codex')];
    const found = candidates.find(isFile);
    if (found) return found;
  }
  return undefined;
}

// requireRuntime: true keeps the original Claude requirement; a runtime name requires only that runtime.
export function config(requireRuntime: boolean | Runtime = true): Config {
  const explicit = process.env.AGENT_BRIDGE_CLAUDE_PATH;
  const candidates = pathDirs(process.env.PATH, process.platform).map(p => join(p, process.platform === 'win32' ? 'claude.exe' : 'claude'));
  const executable = explicit ? resolve(explicit) : candidates.find(existsSync);
  const required = requireRuntime === true ? 'claude' : requireRuntime || null;
  if (!executable && required === 'claude') throw new BridgeError('cli_missing', 'Install Claude Code and run claude auth login, or set AGENT_BRIDGE_CLAUDE_PATH to its executable.');
  const explicitCodex = process.env.AGENT_BRIDGE_CODEX_PATH;
  const scriptShim = explicitCodex && process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(explicitCodex);
  if (scriptShim && required === 'codex') {
    throw new BridgeError('invalid_config', 'AGENT_BRIDGE_CODEX_PATH must name the native codex.exe, not a shell script shim.');
  }
  const codexExecutable = scriptShim ? undefined : explicitCodex ? resolve(explicitCodex) : discoverCodex();
  if (!codexExecutable && required === 'codex') throw new BridgeError('cli_missing', 'Install Codex and run codex login, or set AGENT_BRIDGE_CODEX_PATH to its native executable.');
  const maxActive = parseConcurrency(process.env.AGENT_BRIDGE_MAX_ACTIVE);
  return {
    stateDir: resolve(process.env.AGENT_BRIDGE_HOME ?? join(homedir(), '.agent-bridge')), executable: executable ?? '',
    ...(codexExecutable ? { codexExecutable } : {}), maxActive, staleMs: 120_000,
  };
}
