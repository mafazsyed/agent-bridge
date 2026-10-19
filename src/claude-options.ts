import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.js';

// Discovery and delegated turns must use the same executable and configuration boundary.
export function claudeOptions(settings: Config): Pick<Options, 'pathToClaudeCodeExecutable' | 'settingSources' | 'mcpServers' | 'strictMcpConfig' | 'extraArgs' | 'env'> {
  return {
    pathToClaudeCodeExecutable: settings.executable,
    settingSources: [], mcpServers: {}, strictMcpConfig: true,
    extraArgs: { 'no-chrome': null, 'disable-slash-commands': null },
    env: { ...process.env, AGENT_BRIDGE_DELEGATION_DEPTH: '1' },
  };
}
