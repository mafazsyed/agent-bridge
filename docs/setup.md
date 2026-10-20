# Set up Agent Bridge with your agent

This guide is for Codex or Claude Code carrying out the [README setup prompt](../README.md#set-up-with-your-agent) on the user's computer. Install Agent Bridge, connect the installed clients and verify what works.

## 1. Check the machine

Detect the OS and shell. Locate Node, npm, Git, Claude Code and Codex with the shell's executable lookup; record absolute paths. Node must be version 24 or newer. Git is needed for this source installation and for delegated write tasks.

Check the requirements in [Manual setup](../README.md#manual-setup), including native executables on Windows. A desktop app alone does not establish that its CLI is available.

If a prerequisite or agent CLI is missing or incompatible, explain the next step using its official instructions:

- [Node.js](https://nodejs.org/en/download)
- [Git](https://git-scm.com/downloads)
- [Claude Code](https://code.claude.com/docs/en/setup)
- [Codex CLI](https://developers.openai.com/codex/cli/)

Do not install or upgrade these prerequisites automatically. Continue any setup that does not depend on the missing item. With only one CLI, the bridge can still be built and registered, but delegation to the missing runtime is unavailable.

## 2. Build or reuse the bridge

Inspect any existing `agent-bridge` MCP registration first. Reuse a working checkout instead of creating a second installation. Preserve custom environment settings, local edits and running jobs.

For a new installation, choose a permanent, user-writable folder outside the current project and temporary directories, for example `~/.local/share/agent-bridge` on macOS/Linux or `%LOCALAPPDATA%\AgentBridge\source` on Windows. Keep it separate from `~/.agent-bridge`, which holds runtime state.

Run these commands with the chosen destination substituted and correctly quoted for the shell:

```sh
git clone https://github.com/mafazsyed/agent-bridge.git "/absolute/path/to/agent-bridge"
cd "/absolute/path/to/agent-bridge"
npm ci
npm run build
```

This is a source installation; do not substitute an assumed npm package or `npx` installer. If an existing checkout needs updating, use a fast-forward update only when it is clean and no jobs are active. Never reset or discard local work to complete setup.

For each installed runtime, run its diagnostic:

```sh
node dist/cli.js doctor claude
node dist/cli.js doctor codex
```

Run only the applicable commands. The diagnostic reports the native executable and runtime version; it **does not test authentication**. Resolve any reported incompatibility before claiming that runtime is ready.

## 3. Register the installed clients

Register one user-level stdio server named `agent-bridge` in each installed client. Use absolute paths to both Node and `dist/cli.js`, so GUI clients can launch it without a shell's Node version manager.

These are templates; substitute real paths and quote them for the detected shell:

```sh
codex mcp add agent-bridge -- "/absolute/path/to/node" "/absolute/path/to/agent-bridge/dist/cli.js" mcp
claude mcp add --scope user agent-bridge -- "/absolute/path/to/node" "/absolute/path/to/agent-bridge/dist/cli.js" mcp
```

If needed, add `--env "AGENT_BRIDGE_CLAUDE_PATH=/absolute/path/to/claude"` and/or `--env "AGENT_BRIDGE_CODEX_PATH=/absolute/path/to/codex"` before `--`, using the native executable paths reported by `doctor`. On Windows these must point to `.exe` files, not `.cmd` shims; keep bundled execution helpers in place. For Codex, put the environment options after `agent-bridge`; Claude accepts them before the server name.

If a registration already exists, inspect it with `codex mcp get agent-bridge` or `claude mcp get agent-bridge`. Leave a matching registration alone. Back up configuration before changing an existing entry; preserve its unrelated settings, environment variables and permission choices.

Keep current approval and sandbox settings. Setup does not require bypass permissions, full access, or automatic trust for every tool. If a client blocks MCP calls, explain its approval requirement using [Codex tool approval](../README.md#codex-tool-approval) or the client's own prompt.

Command references: [Codex MCP](https://developers.openai.com/codex/mcp/) and [Claude Code MCP](https://code.claude.com/docs/en/mcp).

## 4. Add the delegation instructions

Copy the appropriate bundled skill directory into the installed client's user skill directory:

| Client | Copy from this repository | Destination |
| --- | --- | --- |
| Codex | `skills/claude-delegation` | `~/.agents/skills/claude-delegation` |
| Claude Code | `skills/codex-delegation` | `~/.claude/skills/codex-delegation` |

Use the user's home directory on Windows too. Honor an existing configured skill location. If an enabled Agent Bridge plugin already supplies the skill, reuse it instead of installing a duplicate. Leave identical copies alone; preserve locally customized skills rather than overwriting them.

Skill references: [Codex](https://developers.openai.com/codex/skills/) and [Claude Code](https://code.claude.com/docs/en/skills).

## 5. Verify and report

Check the saved MCP registrations and run `node dist/cli.js models claude` and/or `node dist/cli.js models codex` for installed targets. These discover native models without sending an inference prompt. A catalogue is not proof of entitlement, remaining quota or a successful delegated task.

If authentication is required, direct the user to `claude auth login` or `codex login`. The user completes sign-in in that runtime; never request passwords, tokens or returned login codes in chat.

Reload or restart the host if it has not picked up the server and skills. Once available, use Agent Bridge's `list_conversations` to verify a tool round trip without starting a job. Do not print private conversation contents as part of the setup report.

Finish with a short report containing:

- The installation folder and clients configured.
- Which targets passed diagnostics and model discovery.
- Whether a tool call through each host was actually verified, or still needs restart/approval.
- Any missing CLI, login or other action the user needs to complete.

Do not label saved configuration alone as a working integration. A real model task consumes the user's account allowance; offer a small read-only delegation test after setup, and report its result separately if the user asks for one.
