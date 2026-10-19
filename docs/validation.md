# Validation record

Private preview, 19 October 2026. No model credentials are included in this repository.

## Native runtime checks on macOS

Node 26.5.0, installed Claude Code 2.1.302, Claude Agent SDK 0.3.303. Requested model: `claude-opus-5-5`, effort: `high`. Init events confirmed the model; the requested effort was passed through the SDK, not independently measured.

- SDK → installed CLI → SDK: retained one session UUID and a random conversation marker, including a workspace with a trailing space on an external volume.
- Detached bridge review read fixture content. A requested write in review mode did not create the file.
- A queued follow-up retained the conversation's marker.
- Write mode edited an isolated worktree without changing the source checkout. An exact harmless `git diff --stat` command waited for approval and ran after approval.
- A real AskUserQuestion waited for the host's answer and resumed with it.
- Cancellation while awaiting input completed, refused a late answer, and allowed a later turn on the same conversation.
- Opus reviewed the implementation through the bridge itself. Its review was read-only; test execution was performed separately by the implementing agent.

One native Claude absolute-path read on this external volume was rejected by its own suspicious-path check. Claude retried a relative path successfully. The bridge did not override the native runtime's refusal.

## Codex integration

Installed the stdio MCP server and delegation skill in Codex's shared configuration. A fresh Codex CLI 0.163.0 session loaded both and called the installed server; this was not a direct bridge script standing in for Codex.

- Read-only inspection listed existing conversations and runs and retrieved a completed Opus result.
- Codex started a real Opus 5.5 review, answered its AskUserQuestion, and continued the same conversation. The follow-up recalled a random marker and the chosen answer without rereading files or using tools.
- Codex started a separate write conversation. Opus created the exact requested file in its worktree, stopped for an exact `git diff --stat` approval, then completed after Codex supplied the authorized one-time decision.
- Independent checks of MCP call records, the persisted runs and permissions, and Git/file state confirmed all three runs succeeded, the answer and command decisions were consumed once, and the source checkout was unchanged.

The initial write-capable MCP call was blocked by Codex's existing `never` approval policy. After explicit user authorization, automatic tool approval was enabled for Agent Bridge alone. The global approval policy and every other Codex setting were preserved. This host trust does not remove the bridge's per-command decision or imply that unrequested commands are authorized.

## Automated checks

`npm run check` runs TypeScript checks, serialized tests, then a build. The tests cover SQLite transactions across processes, idempotency, queued turns, global concurrency, uncertain outcomes, cancellation, permission expiry/one-time answers, path restrictions, case variants, symlinks, incomplete worktree setup, lost launches, process identity after stale heartbeats, MCP handlers and detached workers surviving their client.

Process tests exercise the real compiled CLI, SDK transport, workers, SQLite and stdio MCP. Only the model process is a deterministic protocol fixture. They do not prove native Claude compatibility on other operating systems. The first GitHub CI run passed this suite on Node 24 on macOS, Windows and Linux: [run 39307054507](https://github.com/mafazsyed/agent-bridge/actions/runs/39307054507). This used the same application source as the private-preview commit; later CI setup changes do not add native-model coverage.

The final local suite passed 28 tests. Opus re-reviewed the corrections and found no remaining blocker for the macOS private preview. Its review is not a substitute for native acceptance on other platforms.

Local POSIX privacy modes are tested; Windows uses the user's filesystem ACLs. Tests use spaces in workspace paths everywhere and trailing spaces only where the filesystem supports them.

## Limits

- Native Claude acceptance has been performed on macOS only. Windows/Linux native authentication, shell permissions and model calls still need hands-on acceptance before a stable cross-platform release.
- Sleep handling has a stale-clock/process-identity regression test; no physical laptop sleep test was performed.
- Local job persistence survives client exit, not arbitrary OS termination. No automatic wake-up of an idle host and no exactly-once execution guarantee.
- Worktrees and tool restrictions are not an OS sandbox. Approved commands and trusted repository checkout filters can have broader effects.
- The bridge refuses missing transcripts and incomplete worktrees rather than silently starting fresh or resetting files.
- The plugin packaging is included, but this validation used MCP clients/CLI directly; marketplace installation is not claimed.

Real-model scripts are optional and consume Claude account usage. Local detailed evidence is ignored under `.local/`; do not commit private transcripts or state directories.
