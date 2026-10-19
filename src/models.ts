import { query, type ModelInfo, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from './config.js';
import { BridgeError } from './types.js';
import { claudeOptions } from './claude-options.js';

type OpenQuery = (input: Parameters<typeof query>[0]) => Pick<Query, 'supportedModels' | 'close'>;
export interface ModelCatalogue {
  source: 'claude-code';
  fetchedAt: string;
  models: {
    value: string;
    resolvedModel: string | null;
    displayName: string;
    description: string;
    supportsEffort: boolean | null;
    supportsAutoMode: boolean | null;
    supportedEffortLevels: NonNullable<ModelInfo['supportedEffortLevels']> | null;
  }[];
}

// Coalesce overlapping calls in one MCP server, but never keep a completed catalogue.
export function createModelDiscovery(settings: Config, discover = discoverModels): () => Promise<ModelCatalogue> {
  let pending: Promise<ModelCatalogue> | undefined;
  return () => pending ??= discover(settings).finally(() => { pending = undefined; });
}

// The empty input stream keeps the control channel alive without submitting a turn.
// Use an empty temporary cwd so discovery is independent of any project or saved job.
export async function discoverModels(settings: Config, { open = query, timeoutMs = 20_000, remove = rm }: { open?: OpenQuery; timeoutMs?: number; remove?: typeof rm } = {}): Promise<ModelCatalogue> {
  if (!settings.executable) throw new BridgeError('cli_missing', 'Install Claude Code before listing its models.');
  const cwd = mkdtempSync(join(tmpdir(), 'agent-bridge-models-'));
  const abort = new AbortController();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> { await held; })();
  let runtime: ReturnType<OpenQuery> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BridgeError('model_discovery_timeout', 'Claude model discovery timed out. Check the installed CLI and its sign-in, then retry.')), timeoutMs);
    });
    runtime = open({ prompt, options: {
      ...claudeOptions(settings), cwd, abortController: abort, tools: [],
      permissionMode: 'dontAsk', persistSession: false,
      canUseTool: async () => ({ behavior: 'deny', message: 'Model discovery cannot execute tools.' }),
    } });
    const models = await Promise.race([runtime.supportedModels(), deadline]);
    return { source: 'claude-code', fetchedAt: new Date().toISOString(), models: models.map(m => ({
      value: m.value, resolvedModel: m.resolvedModel ?? null,
      displayName: m.displayName, description: m.description,
      supportsEffort: m.supportsEffort ?? null,
      supportsAutoMode: m.supportsAutoMode ?? null,
      supportedEffortLevels: m.supportedEffortLevels ?? null,
    })) };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('model_discovery_failed', `Unable to read Claude's model catalogue: ${String(error).slice(0, 1000)}`);
  } finally {
    clearTimeout(timer);
    release();
    abort.abort();
    try { await runtime?.close(); } catch { /* Abort was already signalled; preserve the probe outcome. */ }
    // close() initiates child shutdown. Let the event loop reap it before Windows
    // retries removing the child's cwd; synchronous retries keep that cwd locked.
    // An OS/antivirus lock on this neutral directory must not mask that outcome.
    await remove(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}
