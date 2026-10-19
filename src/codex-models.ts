import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from './config.js';
import { BridgeError } from './types.js';
import { CodexClient } from './codex-client.js';

export interface CodexModel {
  id: string; model: string; displayName: string; description: string; isDefault: boolean;
  defaultReasoningEffort: string; supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
}
export async function codexModels(client: CodexClient): Promise<CodexModel[]> {
  const models: CodexModel[] = []; const seen = new Set<string>(); let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const result = await client.request('model/list', { cursor, limit: 100 });
    if (!Array.isArray(result?.data)) throw new BridgeError('codex_protocol', 'Codex returned an invalid model catalogue.');
    for (const m of result.data) {
      if (typeof m.model !== 'string' || !Array.isArray(m.supportedReasoningEfforts)) throw new BridgeError('codex_protocol', 'Codex model capabilities are missing.');
      models.push({ id: m.id, model: m.model, displayName: m.displayName, description: m.description,
        isDefault: m.isDefault === true, defaultReasoningEffort: m.defaultReasoningEffort,
        supportedReasoningEfforts: m.supportedReasoningEfforts.map((e: any) => ({ reasoningEffort: e.reasoningEffort, description: e.description })) });
    }
    cursor = result.nextCursor ?? null;
    if (!cursor) return models;
    if (seen.has(cursor)) break;
    seen.add(cursor);
  }
  throw new BridgeError('codex_protocol', 'Codex model pagination did not terminate.');
}
export async function discoverCodexModels(settings: Config, { timeoutMs = 20_000, open = (exe: string, cwd: string) => new CodexClient(exe, cwd) } = {}) {
  if (!settings.codexExecutable) throw new BridgeError('cli_missing', 'Install Codex or set AGENT_BRIDGE_CODEX_PATH to its native executable.');
  const cwd = mkdtempSync(join(tmpdir(), 'agent-bridge-codex-models-'));
  const client = open(settings.codexExecutable, cwd);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const models = await Promise.race([
      (async () => { await client.initialize(); return codexModels(client); })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BridgeError('model_discovery_timeout', 'Codex model discovery timed out.')), timeoutMs); }),
    ]);
    return { source: 'codex' as const, fetchedAt: new Date().toISOString(), models: models.map(m => ({
      value: m.model, resolvedModel: m.model, displayName: m.displayName, description: m.description,
      isDefault: m.isDefault, defaultEffort: m.defaultReasoningEffort,
      supportsEffort: m.supportedReasoningEfforts.length > 0,
      supportedEffortLevels: m.supportedReasoningEfforts.map(e => e.reasoningEffort),
    })) };
  } finally { clearTimeout(timer); await client.close(); await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {}); }
}
