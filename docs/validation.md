# Validation record

Cross-platform preview, 19 October 2026. No model credentials are included in this repository.

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

## Native Windows and Linux acceptance

Real authenticated Claude calls passed on both remote machines over SSH. These used native Claude executables, not the deterministic CI inference fixture.

| Host | Node | Claude Code | Result |
| --- | --- | --- | --- |
| Linux x64 | 24.22.0 | 2.1.295 | Passed |
| Windows 11 x64 | 24.22.0 | 2.1.303 | Passed |

Both hosts passed SDK → native CLI → SDK continuation, review without writes, queued follow-up context, isolated worktree writes, exact command approval, questions, cancellation, refusal of late answers and resuming the cancelled conversation. A real stdio MCP client then continued the existing Opus conversation using `sonnet` with medium effort, disconnected and reconnected, and retrieved its successful result. The runtime reported `claude-sonnet-5-5`; it retained the random marker without rereading files. This extends native MCP coverage; the full Codex host acceptance described below was performed on Mac.

Two issues were corrected during acceptance:

- Windows' original Claude Code 2.1.195 authenticated but the model endpoint refused Opus 5.5 because it requires 2.1.280 or newer. Updating the installed CLI resolved it. The requirement is now documented.
- Claude dropped a trailing space from a Linux fixture's workspace path. The bridge correctly denied that sibling path. The runtime instructions now provide the exact JSON-encoded workspace and recommend relative file paths; the same live test then passed. A regression test verifies that a trailing-space workspace remains distinct from its trimmed sibling. The live fixture uses embedded spaces on Windows, where trailing-space directory names are not supported normally.

Independent ledger and file checks confirmed successful outcomes, one consumed approval for exactly `git diff --stat`, preserved conversation identities, expected cancellation states, an unchanged source checkout, and edits only in the assigned worktree. The updated runtime also passed the Mac live review/write suite again. Node 24 was installed only inside the remote acceptance directories, leaving their default Node installations unchanged.

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

The initial local suite passed 28 tests. Opus re-reviewed those corrections and found no remaining blocker for the macOS private preview. After native cross-platform acceptance and the workspace-path correction, the updated suite passed 29 tests on Mac and Linux; Windows passed 28 with the POSIX trailing-space case skipped. Typechecks and builds passed on all three hosts. The later path-instruction change was verified by tests and live acceptance, not a new Opus review.

Local POSIX privacy modes are tested; Windows uses the user's filesystem ACLs. Tests use spaces in workspace paths everywhere and trailing spaces only where the filesystem supports them.

## Model discovery acceptance

The `list_models` MCP tool and `models` CLI command were exercised against the installed native Claude runtime on all three hosts above. Each returned Claude's own 13-entry catalogue, including aliases, resolved model IDs and effort capabilities. Older entries without capability fields remained unknown. These are runtime picker results, not proof of entitlement to every model.

A fresh Codex CLI session called the installed MCP tool, selected Sonnet with a reported effort level and correctly identified missing effort metadata. Discovery also succeeded while another bridge inference job occupied the single active-run slot. Separate native MCP checks confirmed discovery created no runs or conversations. The installed delegation skill was updated and validated.

The expanded suite passes 37 tests on Mac and Linux, and 36 on Windows with the POSIX-only path test skipped; typechecks and builds pass. New cases cover exact metadata preservation, unknown versus unsupported capabilities, rejection of tool execution, account-field filtering, zero inference input frames, concurrent probe coalescing, refresh after errors, terminating an actual SDK child on discovery timeout, and preserving probe outcomes when cleanup fails. Requested versus reported applied effort is checked with a protocol fixture; absent applied-effort metadata is explicitly marked unreported.

Windows acceptance found that synchronous temporary-directory cleanup blocked the event loop while the SDK child still held its working directory. Cleanup now retries asynchronously so process shutdown can complete. Both the timeout regression and live native discovery passed after the fix. Native inference/continuation evidence in the preceding sections is unchanged; this addition does not claim to have re-tested every model in the catalogue.

Opus 5.5 reviewed the design and then the implementation through native Agent Bridge runs. It found no blocking correctness, privacy or lifecycle issue, and recommended preserving results when final cleanup fails; that recommendation was implemented with a regression test. The review run also confirmed a real host can omit applied effort, which the bridge marks unreported. Reviews were read-only; the implementing agent ran and inspected the tests independently.

## Claude Code → Codex acceptance

The reverse adapter uses the native Codex app-server protocol. Generated schemas from Codex 0.163.0 were used to check the request/response fields. It retains a separate native thread ID and uses the same ledger, queue and worktree lifecycle as Claude jobs.

Authenticated native acceptance ran on macOS (Node 26.5.0), Linux x64 and Windows 11 x64 (both Node 24.22.0), using Codex 0.163.0 and the runtime catalogue's default `gpt-6.1-sol` with reported `low` effort. Each host exercised catalogue discovery, a real read of a random fixture, a requested write in review mode leaving no file, remembered context on follow-up, a write in the assigned worktree leaving the source checkout unchanged, a one-time command approval, cancellation and resuming the same native conversation afterward.

A separate real Claude Code host, using Opus 5.5/high, called the new MCP tools on each OS. It discovered Codex's models, started a review, waited for completion and continued that saved conversation. Independent ledger checks verified two successful Codex turns sharing one native identity and recalling the fixture marker without rereading it. These were actual host-to-MCP-to-runtime calls, not simulated host decisions. Other models in the catalogues were not exhaustively tested.

Native acceptance uncovered and corrected the Windows executable lookup for current npm layouts, inherited MCP map merging (individual servers must be disabled), and an unnecessary override of Windows' configured sandbox. Windows now keeps its native implementation. Approvals are checked against exact fixture actions, including native shell wrapping. On this Windows host, sandboxed commands started over SSH intermittently failed with native runner pipe timeouts or error 267. A direct native `command/exec` probe reproduced the failure without Agent Bridge's turn adapter. Running the same executable and command under an interactive Windows logon read the fixture successfully and rejected the write with `EPERM`; the file remained absent. Use an interactive Windows session for native sandboxed commands on this host. The bridge does not weaken the sandbox to work around SSH session restrictions.

Ubuntu's AppArmor configuration blocked unprivileged user namespaces used by Codex's bubblewrap sandbox. The owner installed a narrow profile for a root-owned isolated Codex binary and its official bundled execution helper. Global AppArmor restrictions remained enabled. This host setup was required for the native test; Agent Bridge does not install profiles, elevate itself or fall back to an unsandboxed runtime.

New automated cases cover v1 ledger migration and fingerprint stability, immutable runtime selection, native ID binding and lease fencing, real stdio framing and pagination, disabled inherited MCP servers, native sandbox checks, early completion before the start acknowledgement, transport failure before/after dispatch, wrong-thread requests, questions, withdrawn approvals, refusal of review escalation, process-tree cancellation and bounded model discovery. Protocol fixtures make these cases deterministic; they supplement the native checks above.

Opus 5.5 reviewed the implementation and re-reviewed the corrections. Terminal-input approvals are refused rather than misrepresented as command approvals; refreshed patch snapshots invalidate stale decisions; startup cancellation closes pending RPCs; and an emergency owner exit synchronously stops the owned app-server tree. Regression tests cover each path. Native-rule trust and Windows sandbox-account process cleanup limits are explicit in the documentation.

The final automated suite passed 72 tests on Mac and Linux, and 71 on Windows with the POSIX-only trailing-space path case skipped. Typechecks and builds passed on all three hosts. The native Windows lifecycle suite also passed from an interactive session: its review write was denied, its isolated edit and one-time command approval succeeded, and the actual sandboxed Node PID exited after cancellation. The same native PID check passed on Mac; Linux resolves namespace PIDs to the corresponding host process before checking exit.

The Mac's Claude Code user configuration now registers Agent Bridge, and its `codex-delegation` skill is installed. A fresh native connection check reports the server connected. The repository provides the same setup instructions for other machines; acceptance profiles do not silently install user-wide MCP configuration there.

## Limits

- Native acceptance covers the specific Mac, Windows and Linux configurations above, with Opus 5.5 and a Sonnet 5.5 follow-up. It does not establish compatibility with every shell, operating-system version, model or enterprise policy.
- Sleep handling has a stale-clock/process-identity regression test; no physical laptop sleep test was performed.
- Local job persistence survives client exit, not arbitrary OS termination. No automatic wake-up of an idle host and no exactly-once execution guarantee.
- Worktrees and tool restrictions are not an OS sandbox. Approved commands and trusted repository checkout filters can have broader effects.
- The bridge refuses missing transcripts and incomplete worktrees rather than silently starting fresh or resetting files.
- The plugin packaging is included, but this validation used MCP clients/CLI directly; marketplace installation is not claimed.

Real-model scripts are optional and consume the selected native account usage. Local detailed evidence is ignored under `.local/`; do not commit private transcripts or state directories.
