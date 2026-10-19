import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import type { ModelInfo, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createModelDiscovery, discoverModels } from '../src/models.js';

const settings = { executable: 'fixture-claude', stateDir: 'unused', maxActive: 1, staleMs: 120_000 };
test('model discovery preserves runtime aliases and unknown capabilities without submitting a prompt', async () => {
  const models: ModelInfo[] = [
    { value: 'future-alias', resolvedModel: 'future-version', displayName: 'Future model', description: 'Runtime description', supportsEffort: true, supportedEffortLevels: ['low', 'xhigh'] },
    { value: 'legacy', displayName: 'Legacy', description: 'No capability fields' },
    { value: 'fixed', displayName: 'Fixed', description: 'Explicitly no effort', supportsEffort: false, supportedEffortLevels: [] },
  ];
  let closed = 0, options!: Options, next!: Promise<IteratorResult<SDKUserMessage>>;
  const result = await discoverModels(settings, { open: input => {
    options = input.options!;
    next = (input.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();
    return { supportedModels: async () => models, close: () => { closed++; } };
  } });
  assert.equal(result.source, 'claude-code');
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.deepEqual(result.models[0], models[0]);
  assert.equal(result.models[1]!.supportsEffort, null);
  assert.equal(result.models[1]!.supportedEffortLevels, null);
  assert.equal(result.models[2]!.supportsEffort, false);
  assert.deepEqual(result.models[2]!.supportedEffortLevels, []);
  assert.deepEqual(await next, { value: undefined, done: true });
  assert.deepEqual(options.tools, []); assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.mcpServers, {}); assert.equal(options.strictMcpConfig, true);
  assert.equal(options.persistSession, false); assert.equal(options.permissionMode, 'dontAsk');
  assert.equal(options.pathToClaudeCodeExecutable, settings.executable);
  assert.equal(options.model, undefined); assert.equal(options.effort, undefined);
  assert.equal((await options.canUseTool!('Bash', { command: 'echo unwanted' }, { signal: new AbortController().signal, toolUseID: 'fixture', requestId: 'fixture' }))?.behavior, 'deny');
  assert.equal(closed, 1); assert.equal(existsSync(options.cwd!), false);
});

test('concurrent discovery is coalesced; successes and failures are not cached', async () => {
  let calls = 0, release!: (value: any) => void, reject!: (reason: Error) => void;
  const discover = createModelDiscovery(settings, async () => {
    calls++;
    return new Promise((resolve, fail) => { release = resolve; reject = fail; });
  });
  const a = discover(), b = discover();
  assert.equal(a, b); assert.equal(calls, 1);
  const catalogue = { source: 'claude-code', fetchedAt: 'fixture', models: [] };
  release(catalogue);
  assert.equal(await a, catalogue);
  const c = discover(); assert.equal(calls, 2);
  reject(new Error('fixture unavailable'));
  await assert.rejects(c, /unavailable/);
  const d = discover(); assert.equal(calls, 3);
  release(catalogue); await d;
});

test('model discovery times out and closes a runtime which never answers', async () => {
  let closed = false, options!: Options;
  await assert.rejects(discoverModels(settings, { timeoutMs: 10, open: input => {
    options = input.options!;
    return { supportedModels: () => new Promise(() => {}), close: () => { closed = true; } };
  } }), { code: 'model_discovery_timeout' });
  assert.equal(closed, true); assert.equal(options.abortController!.signal.aborted, true);
  assert.equal(existsSync(options.cwd!), false);
});

test('failed discovery returns an error and a later call fetches fresh metadata', async () => {
  let count = 0, closed = 0;
  const open = () => ({ supportedModels: async (): Promise<ModelInfo[]> => {
    if (++count === 1) throw new Error('fixture auth unavailable');
    return [{ value: 'account-changed', displayName: 'New account', description: 'Fresh catalogue' }];
  }, close: () => { closed++; } });
  await assert.rejects(discoverModels(settings, { open }), { code: 'model_discovery_failed' });
  const result = await discoverModels(settings, { open });
  assert.equal(result.models[0]!.value, 'account-changed');
  assert.equal(closed, 2);
});

test('model discovery requires a runtime and reports an empty catalogue honestly', async () => {
  await assert.rejects(discoverModels({ ...settings, executable: '' }), { code: 'cli_missing' });
  const result = await discoverModels(settings, { open: () => ({ supportedModels: async () => [], close() {} }) });
  assert.deepEqual(result.models, []);
});

test('shutdown and directory cleanup errors do not mask a catalogue or its failure', async () => {
  for (const outcome of ['success', 'failure', 'timeout']) {
    let options!: Options, closeCalled = false, removeCalled = false;
    try {
      const result = discoverModels(settings, { timeoutMs: 10, open: input => {
        options = input.options!;
        return {
          supportedModels: async () => {
            if (outcome === 'failure') throw new Error('fixture probe failure');
            if (outcome === 'timeout') return new Promise<ModelInfo[]>(() => {});
            return [];
          },
          close: () => { closeCalled = true; throw new Error('fixture close failure'); },
        };
      }, remove: async () => { removeCalled = true; throw Object.assign(new Error('fixture directory locked'), { code: 'EBUSY' }); } });
      if (outcome === 'success') assert.deepEqual((await result).models, []);
      else await assert.rejects(result, { code: outcome === 'timeout' ? 'model_discovery_timeout' : 'model_discovery_failed' });
      assert.equal(closeCalled, true); assert.equal(removeCalled, true);
      assert.equal(options.abortController!.signal.aborted, true);
    } finally { rmSync(options.cwd!, { recursive: true, force: true }); }
  }
});
