# Agent Bridge

Persistent local delegation between Claude Code and Codex, available to MCP clients. Start a review or isolated implementation task, keep working, then inspect progress and continue the same native conversation.

Public preview.

## Setup

Requirements: **Node 24+**, Git for implementation tasks, and the installed native executable for the runtime you want to delegate to (Claude Code, Codex, or both). Authenticate through the runtime itself: `claude auth login` or `codex login`. Agent Bridge does not collect credentials or provide a separate sign-in service.

Use a current native Codex CLI (this adapter is tested with **0.163.0**) for Codex delegation. Keep its bundled execution helpers beside the executable; do not copy only the main binary. Older or incompatible protocol/configuration responses fail without dispatching a prompt.

Use a current Claude Code version. The default Opus 5.5 model requires Claude Code 2.1.280 or newer; an older executable can authenticate successfully but still be refused when it calls that model. Run `claude update` if the runtime reports that it is too old.

On Windows, install the native `claude.exe`; npm `.cmd` wrappers are not executed through a shell. Saved jobs can be inspected and cancelled even if Claude has been removed. Starting new jobs requires the executable.

```sh
git clone https://github.com/mafazsyed/agent-bridge.git
cd agent-bridge
npm ci
npm run build
node dist/cli.js doctor
```

Configure a local stdio MCP server in your client:

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/agent-bridge/dist/cli.js", "mcp"]
    }
  }
}
```

For Codex CLI, the equivalent is `codex mcp add agent-bridge -- node /absolute/path/to/agent-bridge/dist/cli.js mcp`. Paths containing spaces must be quoted in your shell. The repository also includes a portable `plugin.json`, `mcp.json` and a `skills/claude-delegation` skill. Build the checkout before registering it as a local plugin; Git alone does not supply `dist` or dependencies. No lifecycle hooks or automatic configuration edits are required.

### Codex tool approval

Registration and trust are separate. If Codex reports `MCP tool call requires approval, but approval policy is never`, the server connected, but that profile cannot approve the call. Choose interactive approval, or explicitly trust this server in Codex's configuration:

```toml
[mcp_servers.agent-bridge]
# Keep the existing command, args and env configuration.
default_tools_approval_mode = "approve"
```

Only enable that setting when you want Codex to call all of this server's tools, including `answer_permission`, under your task instructions. A delegated Bash command still stops at the bridge's one-time approval; this setting lets Codex supply that approval when your authorization covers it. It does not make the worktree a sandbox. The delegation skill explains the workflow. See [Codex MCP configuration](https://developers.openai.com/codex/mcp/) for per-tool alternatives.

## Use

Ask your MCP-enabled agent to delegate a review to Opus. It can use:

| Tool | Purpose |
| --- | --- |
| `list_models` | Read the selected runtime's live model catalogue and effort capabilities |
| `start_run` | Start a job or queue a follow-up on a conversation |
| `get_run` | Read status, results, pending input and progress pages |
| `wait_run` | Wait up to 50 seconds for changes |
| `cancel_run` | Request cancellation; poll until terminal |
| `answer_permission` | Approve or deny one command, or answer a question |
| `list_runs` | Find recent jobs without calling a runtime |
| `list_conversations` | Find reusable sessions and workspaces |

Example `start_run` input:

```json
{
  "requestKey": "auth-review-1",
  "cwd": "/path/to/project",
  "prompt": "Review the authentication change and report actionable findings with file references.",
  "model": "claude-opus-5-5",
  "effort": "high"
}
```

The default is review mode, Opus 5.5 and high effort. The account must have access to the requested model. The bridge does not configure automatic fallback; Claude Code resolves aliases and applies its own account policies. The runtime's reported model and requested effort are recorded in the run's `started` event. When Claude reports the applied effort, `effortReported` is true and `effortApplied` contains its value (or null if no effort parameter applies). Otherwise `effortReported` is false: the applied effort is unknown, not necessarily the requested value. Each new turn gets a new request key. Repeating the exact input with the same key returns the original job rather than dispatching it again. Follow-ups pass `conversationId` instead of `cwd`; their model and effort can be overridden per turn.

Opus is not required. Ask Codex to call `list_models`, or run `node dist/cli.js models`. The bridge queries the installed Claude Code runtime through the official Agent SDK's `supportedModels()`, without submitting a prompt, creating a saved run or using a model-task slot. Discovery can make network requests through Claude; it is not an offline entitlement check. It has a 20-second deadline. Overlapping calls within one MCP server share a probe; completed results are not cached.

Each entry preserves Claude's `value` alias, `resolvedModel` when supplied, display name, description and reported effort support. Use `value` to follow Claude's alias selection or the resolved ID to request that version explicitly. Choose effort from `supportedEffortLevels`; null capability fields mean unknown, while `supportsEffort: false` means the runtime reports no effort support. The bridge's default remains high; Claude can ignore or cap effort according to the model and account policy. Account details from initialization are not returned. The catalogue is picker metadata, not a guarantee of entitlement or remaining quota; a missing model is not automatically rejected by the bridge. Refresh after changing account or runtime. The MCP catalogue uses the same executable and settings boundary as its delegated runs; a separately configured CLI can see a different catalogue. See [Claude model configuration](https://code.claude.com/docs/en/model-config).

For implementation, add `"mode": "write", "baseRef": "HEAD"` to a **new** conversation. The bridge creates a branch and worktree from that commit. It leaves the original checkout, including uncommitted changes, alone. The result includes the worktree path. Review and integrate that diff deliberately; the bridge does not automatically commit, merge or push.

You can use the CLI independently: pipe the same JSON into `node dist/cli.js start`, then use `get RUN_ID`, `wait RUN_ID`, `cancel RUN_ID`, `runs` and `conversations`. `answer PERMISSION_ID` reads `{ "decision": "allow" | "deny", "answers": { "question": "answer" } }` from stdin. Only supply `answers` for a question.

For incremental progress, use `get RUN_ID CURSOR` and `wait RUN_ID SECONDS CURSOR`, passing the previous `nextCursor`. Cursor zero retrieves existing progress immediately.

## Claude Code → Codex

Register the same server in Claude Code:

```sh
claude mcp add --scope user agent-bridge -- node "/absolute/path/to/agent-bridge/dist/cli.js" mcp
node dist/cli.js doctor codex
node dist/cli.js models codex
```

Copy `skills/codex-delegation` into your Claude skills directory if you want its workflow instructions. Restart the host after registering or upgrading the server. The first upgraded process migrates the ledger to schema 2; older binaries refuse that newer ledger. Keep a backup before downgrading.

Ask Claude to call `list_models({"runtime":"codex"})`, then `start_run` with `"runtime":"codex"`, `cwd`, `requestKey` and `prompt`. Omitted model and effort use Codex's configured defaults (or its native catalogue default); the first start saves the actual selection. Explicit choices must exist in Codex's current catalogue. No model ID or effort list is hard-coded. Follow-ups use `conversationId` and cannot switch runtimes. Per-run model/effort overrides do not change the saved conversation selection.

Codex uses the native `app-server` JSON-RPC protocol over private stdio, not a remote server or a copied credential. Model discovery sends no prompt and creates no thread. Jobs use a saved native thread; `nativeId` in the result is the ID for `codex resume <nativeId>`. A missing transcript is an error, never a silent fresh start. Codex does not expose Claude's `maxTurns` budget, so that argument is rejected for Codex; use `timeoutSeconds` instead.

**Codex permissions:** review requests native read-only with network disabled and refuses new escalation requests. Existing native execution rules can authorize commands outside that sandbox in **both review and write mode**. Reads are not confined to the workspace. Write uses the native workspace sandbox with network disabled and temporary-directory write exemptions removed. Sandboxed commands and edits run without per-command approval; native escalation requests stop for a one-time bridge decision. The bridge never grants session-wide approvals or saves execution rules. An approved escalation can affect resources outside the worktree. Codex does not have Claude's bridge file hooks: inspect changes to agent configuration before integrating a worktree; detected changes produce a warning.

On Windows, the adapter preserves the native sandbox implementation instead of downgrading it. Run from an interactive Windows logon: our native sandbox runner failed under SSH on the tested host, while the interactive session passed. On Ubuntu systems that restrict unprivileged user namespaces, the official Codex installation may need an administrator-managed AppArmor profile; the bridge does not disable host protections.

The adapter disables inherited MCP servers, apps, plugins, hooks and nested delegation, then verifies the effective sandbox and thread MCP status before sending the prompt. It fails if that boundary cannot be established. Native enterprise restrictions still apply. Existing native execution rules can authorize commands outside the sandbox without a new bridge approval; this adapter does not erase your rules. Treat that native configuration as part of the trusted setup. The bridge itself never adds rules or grants standing approvals. Cancellation interrupts the exact turn and closes the app-server process tree it owns, including on the worker’s emergency exit. Windows sandbox commands can run under a separate OS account; native cleanup of those processes depends on the Windows session and sandbox setup. Transport loss after dispatch is an uncertain outcome and is never automatically retried.

## Permissions

**Claude:** review mode exposes only Read, Glob, Grep and AskUserQuestion. Write mode adds Edit, Write and Bash. A pre-tool hook checks file/search paths, including symlinks; direct edits to Git metadata and agent configuration are denied. Project and user settings, external MCP servers and slash commands are not loaded by the bridge's runtime configuration.

Every Bash command requires a one-time host decision. The pending request contains its exact input. Approval must come from the human's existing authorization or a new human decision, never from Claude's request itself. Do not approve arbitrary commands just to clear a blocked job.

**A worktree is not a sandbox.** An approved shell command can access outside it, use the network and run repository scripts. Git checkout can invoke configured filters in the explicitly selected trusted repository. Tool checks are not an OS security boundary against other local processes or filesystem races. No `bypassPermissions` mode is used.

## Lifetimes and recovery

- A **conversation** retains its runtime, native session identity, workspace and mode. It survives completed jobs and can be resumed in that runtime's CLI. Codex's `nativeId` is distinct from the bridge conversation ID.
- A **run** is one submitted turn. Follow-ups queue in insertion order; only one turn runs per conversation.
- A detached **worker process** owns a run and updates its lease. Closing the MCP connection does not normally stop the worker. At most one model task runs at a time by default.
- `needs_input` means a real pending question or permission request. A five-minute deadline expires unanswered requests. Cancellation and expired answers cannot authorize later execution.
- `succeeded` means the runtime returned a successful terminal result. Verify its claims against files/tests; it is not an independent correctness verdict.
- A stale worker or stream that ends without a trustworthy result produces `unknown`. Nothing is automatically replayed. Inspect the saved conversation/worktree, then explicitly acknowledge uncertainty if continuing.

A stale heartbeat is checked against the worker's PID and start identity before fencing it, so sleep does not by itself invalidate a living worker. Inconclusive process probes defer reconciliation; workers must establish their own start identity before launching a runtime. Run deadlines still include time asleep. An abort that does not settle within 60 seconds is recorded as an uncertain outcome, then the worker exits. If the host died before launching a worker, reconciliation marks the unstarted job `failed/worker_start_lost` after two minutes. Repeating the original key returns that failure; submit a **new** key to retry this known unstarted job. Cancellation of an unstarted job is immediate.

To use native Claude continuation, change into the saved conversation's `cwd` and run `claude --resume CONVERSATION_ID`. Do not operate the same session concurrently through both interfaces. If Claude's transcript is missing after a crash, start a new conversation deliberately; the bridge does not silently replace its identity. An incomplete worktree checkout is similarly refused without resetting any user edits. Startup diagnostics, when the ledger cannot be opened, go to private `worker-errors.log`.

There is no exactly-once execution guarantee, no promise that work survives a machine reboot, and no automatic wake-up of an idle Codex chat. A command already executed before cancellation is not undone. Native transcripts remain under each runtime's own management.

## Configuration and storage

| Environment variable | Default |
| --- | --- |
| `AGENT_BRIDGE_HOME` | Dedicated `~/.agent-bridge` state directory |
| `AGENT_BRIDGE_CLAUDE_PATH` | Native `claude` / `claude.exe` found on PATH |
| `AGENT_BRIDGE_CODEX_PATH` | Native `codex` / `codex.exe`; standard npm native binary discovery on Windows |
| `AGENT_BRIDGE_MAX_ACTIVE` | `1` (allowed range 1–4) |

The local SQLite ledger stores prompts, results, progress, permission input and workspace paths. It may contain sensitive task content. State directory and file modes are private on POSIX; Windows access depends on the user's filesystem ACLs. Point the state variable only at a dedicated directory: the bridge applies private directory permissions. The bridge adds no telemetry and does not log authentication environment values. Claude has its own data handling and authentication policies.

`node dist/cli.js prune 30` removes bridge task content older than 30 days, retaining small idempotency receipts and conversation identities. It does not delete worktrees or Claude transcripts. SQLite page reclamation is not secure erasure.

To retire a write conversation, first confirm it has no queued, running or waiting runs, inspect its worktree and preserve or integrate any wanted changes. From the source repository, use `git worktree remove "<saved cwd>"`, then `git branch -d "<saved branch>"`. These commands refuse dirty worktrees or unmerged branches; inspect a refusal instead of forcing deletion. Do not resume a retired conversation. Its ledger record and small readiness receipt remain; automatic worktree retirement is not implemented yet.

## Development and validation

```sh
npm run check
# Optional real-model calls, consuming account usage:
AGENT_BRIDGE_LIVE=1 node --import tsx scripts/runtime-probe.ts
AGENT_BRIDGE_LIVE=1 node --import tsx scripts/live-acceptance.ts
AGENT_BRIDGE_LIVE=1 node --import tsx scripts/live-control.ts
AGENT_BRIDGE_LIVE=1 node --import tsx scripts/live-codex.ts
AGENT_BRIDGE_LIVE=1 node --import tsx scripts/live-claude-to-codex.ts
```

The runtime prototype verifies SDK → CLI → SDK continuation with the same UUID and retained context. The live acceptance script checks review restrictions, queued follow-ups, isolated edits and a specific harmless command approval. Temporary evidence is kept under ignored `.local/`.

See [validation](docs/validation.md) for the tested versions and coverage limits. The official Agent SDK is pinned; native Claude updates require re-running the compatibility probe. This is a source repository: npm package publication and plugin-directory submission are separate steps.

## References

- [Official Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Programmatic Claude CLI](https://code.claude.com/docs/en/headless)
- [Current subscription/SDK guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins)

The MIT license covers this project; dependencies and Claude use retain their own terms. Design references are credited in [NOTICE](NOTICE).
