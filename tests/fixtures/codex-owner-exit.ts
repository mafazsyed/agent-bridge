import { CodexClient } from '../../src/codex-client.js';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const [, , fixture, record] = process.argv;
const client = new CodexClient(process.execPath, process.cwd(), { args: [fixture!, 'stuck-cancel', record!] });
await client.initialize();
await client.request('turn/start', {});
for (let n = 0; n < 200; n++) {
  if (readFileSync(record!, 'utf8').includes('grandchild')) process.exit(17); // Same path as the worker's hard abort backstop.
  await delay(10);
}
await client.close(); process.exit(2);
