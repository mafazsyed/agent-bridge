import { spawn, execFile, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { BridgeError } from './types.js';

export type RpcMessage = { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
// These override child configuration only. Never write the user's Codex settings or copy auth.
export const CODEX_CONFIG = {
  'features.apps': false, 'features.plugins': false, 'features.hooks': false,
  'features.memories': false, 'features.multi_agent': false, 'features.multi_agent_v2': false,
  'features.request_permissions_tool': false, 'features.code_mode.enabled': false,
  'features.remote_control': false, 'features.js_repl': false,
  'features.browser_use': false, 'features.computer_use': false,
  'features.remote_plugin': false, 'features.plugin_hooks': false,
  'features.skill_search': false, 'features.skill_mcp_dependency_install': false,
  'skills.include_instructions': false, 'skills.bundled.enabled': false,
  'memories.generate_memories': false, 'memories.use_memories': false,
  web_search: 'disabled', project_doc_max_bytes: 0,
  'sandbox_workspace_write.network_access': false,
  'sandbox_workspace_write.exclude_tmpdir_env_var': true,
  'sandbox_workspace_write.exclude_slash_tmp': true,
  'sandbox_workspace_write.writable_roots': [],
};

/** One owned native app-server, JSONL on stdio. No shell or remote daemon. */
export class CodexClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly failure: Promise<never>;
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (method: string, params: any, id: string | number) => Promise<any> = async () => { throw new Error('Unsupported server request'); };
  private rejectFailure!: (error: Error) => void;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private buffer = '';
  private failed: Error | null = null;
  private closing = false;
  private disposed?: Promise<void>;
  private exited: Promise<void>;
  // process.exit skips async finally blocks (notably the worker abort backstop).
  private readonly killOnExit = () => {
    const pid = this.child.pid; if (!pid) return;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
      else process.kill(-pid, 'SIGKILL');
    } catch { /* Already gone, or native sandbox owns cleanup of its commands. */ }
  };

  constructor(executable: string, cwd: string, options: { args?: string[]; requestTimeoutMs?: number } = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    const args = options.args ?? ['app-server', '--stdio', ...Object.entries(CODEX_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])];
    this.failure = new Promise<never>((_, reject) => { this.rejectFailure = reject; });
    void this.failure.catch(() => {});
    this.child = spawn(executable, args, { cwd, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_BRIDGE_DELEGATION_DEPTH: '1' } });
    process.once('exit', this.killOnExit);
    this.exited = new Promise(resolve => { this.child.once('close', () => resolve()); this.child.once('error', () => resolve()); });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.read(chunk));
    this.child.stderr.resume(); // Never relay arbitrary runtime configuration/auth diagnostics to MCP.
    this.child.stdin.on('error', () => this.fail(new BridgeError('codex_transport', 'Codex input closed.')));
    this.child.on('error', () => this.fail(new BridgeError('cli_missing', 'Unable to start the native Codex executable.')));
    this.child.on('close', () => this.fail(new BridgeError('codex_transport', 'Codex exited before the protocol completed.')));
  }
  private readonly requestTimeoutMs: number;

  request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<any> {
    if (this.failed || this.closing) return Promise.reject(this.failed ?? new BridgeError('codex_closed', 'Codex is closing.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BridgeError('codex_timeout', `Codex did not answer ${method}.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  notify(method: string, params?: unknown) { this.send({ method, ...(params === undefined ? {} : { params }) }); }
  private send(message: unknown) {
    if (this.failed || this.closing) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private read(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      if (newline > 8_000_000) { this.fail(new BridgeError('codex_protocol', 'Codex frame exceeds 8 MB.')); return; }
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const m: RpcMessage = JSON.parse(line);
        if (!m || typeof m !== 'object') throw new Error('Expected object');
        if (m.method && m.id !== undefined) {
          void this.onRequest(m.method, m.params, m.id).then(result => this.send({ id: m.id, result }),
            () => this.send({ id: m.id, error: { code: -32601, message: 'Request not supported by Agent Bridge.' } }));
        } else if (m.method) this.onNotification(m.method, m.params);
        else if (typeof m.id === 'number') {
          const p = this.pending.get(m.id); if (!p) continue;
          this.pending.delete(m.id); clearTimeout(p.timer);
          if (m.error) p.reject(new BridgeError('codex_rpc', String(m.error.message).slice(0, 2000)));
          else p.resolve(m.result);
        } else throw new Error('Invalid RPC envelope');
      } catch { this.fail(new BridgeError('codex_protocol', 'Invalid Codex protocol frame or notification.')); return; }
    }
    if (this.buffer.length > 8_000_000) this.fail(new BridgeError('codex_protocol', 'Codex frame exceeds 8 MB.'));
  }
  private fail(error: Error) {
    if (this.failed) return;
    this.failed = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.rejectFailure(error);
  }
  async initialize() {
    const result = await this.request('initialize', { clientInfo: { name: 'agent_bridge', title: 'Agent Bridge', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.notify('initialized');
    return result;
  }
  close(): Promise<void> { return this.disposed ??= this.dispose(); }
  private async dispose() {
    this.closing = true;
    this.fail(new BridgeError('codex_closed', 'Codex connection closed.'));
    const pid = this.child.pid;
    if (pid) {
      if (process.platform === 'win32') {
        await new Promise<void>(resolve => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve()));
      } else {
        // The group also owns shell grandchildren, including after the parent exits.
        try { process.kill(-pid, 'SIGTERM'); } catch { /* Already stopped. */ }
        await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 500))]);
        try { process.kill(-pid, 'SIGKILL'); } catch { /* Already stopped. */ }
      }
    }
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
    await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 1000))]);
    process.off('exit', this.killOnExit);
  }
}
