import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.js';

// Discovery and delegated turns must use the same executable and configuration boundary.
export function claudeOptions(settings: Config): Pick<Options, 'pathToClaudeCodeExecutable' | 'settingSources' | 'mcpServers' | 'strictMcpConfig' | 'extraArgs'> {
  return {
    pathToClaudeCodeExecutable: settings.executable,
    settingSources: [], mcpServers: {}, strictMcpConfig: true,
    extraArgs: { 'no-chrome': null, 'disable-slash-commands': null },
  };
}
