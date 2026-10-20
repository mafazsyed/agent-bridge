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

## Native permission selectors (2026-10-19; live checks completed 2026-10-20)

The default controlled-delegation policy is preserved. New native selections are stored independently per run, with a saved conversation default and explicit null reset. Schema v3 adds nullable JSON columns; v1/v2 migration, old request fingerprints, resume overrides and queued-run isolation have regression coverage.

| Check | macOS | Ubuntu | Windows |
| --- | --- | --- | --- |
| Final automated suite | 120 passed | 120 passed | 119 passed; POSIX trailing-space case skipped |
| Typecheck and build | Passed | Passed | Passed |
| Native Claude control discovery, no inference | All six modes confirmed | All six modes confirmed | All six modes confirmed |
| Native Codex schema/requirements discovery | Passed | Passed | Passed |
| Codex full-access isolated file edit | Passed | Passed | Passed |
| Codex automatic review of harmless escalated echo | Passed, no host approval | Passed, no host approval | Passed, no host approval |
| Codex untrusted policy file-edit approval | Passed, one exact approval | Passed, one exact approval | Passed, one exact approval |
| Codex granular policy round trip and completed turn | Passed | Passed | Passed |
| Claude plan, default, acceptEdits, dontAsk, auto, bypassPermissions | All six passed | All six passed | All six passed |
| Claude follow-up restores the conversation's plan default | Passed | Passed | Passed |
| Claude explicit null restores original Bridge permissions | Passed | Passed | Passed |
| Claude bypass still denies a direct out-of-workspace Write | Passed; real hook invoked | Passed; real hook invoked | Passed; real hook invoked |

The MCP handler additionally verifies nested permission input and rejects mixed-runtime keys. Fixtures cover all six Claude choices, predispatch downgrade/refusal, model-level auto refusal, mode drift after dispatch, per-tool mode guards, protected paths, explicit callbacks, no-prompt discovery, Codex reviewer/policy downgrade, granular policy forwarding and refusal of unexpected escalation under never.

The real SDK test found that a held streaming input kept a completed Claude turn open. On the terminal result, the worker now ends its input and lets the CLI flush its transcript and exit normally, bounded to ten seconds. Failed shutdown retains the completed answer with an uncertainty warning. A real SDK fixture verifies flush-before-exit and answer retention after a crash. Cancellation after a result still allows the bounded flush. Claude session-limit failures now classify as rate_limited.

All thirteen live cases (nine Claude and four Codex) passed on macOS, Ubuntu and Windows on 2026-10-20 after the graceful-shutdown change. Plan and dontAsk made no fixture file, default required exactly one approved Write, and acceptEdits, auto and bypassPermissions wrote their requested fixture without host approval. The same conversation resumed across these modes. An omitted follow-up restored the original plan selection, and explicit null restored default, verified from runtime events. Bypass's attempted outside Write invoked the real deny hook and created no file. Codex echoed all five granular booleans unchanged and completed its turn.

An earlier acceptEdits run on the external Mac drive correctly forwarded a native path warning: Claude classified the drive's trailing-space component as a suspicious Windows path pattern. Bridge retained that decision instead of overriding it. Native mode behavior is tested in neutral temporary directories to avoid confusing that separate runtime safeguard with a mode-selection bug. The earlier account-limit blocker cleared before the completed runs. macOS used Claude 2.1.302, Ubuntu 2.1.295, and Windows 2.1.303. Codex acceptance used 0.163.0 on all three hosts. The final typechecks, full automated suites and builds were repeated on all three hosts after the remaining error/cancellation fixes; those paths use deterministic transport regressions rather than another repeat of unchanged successful model calls.

Opus 5.5's review prompted additional regressions for every hung startup control, cancellation and deadline before dispatch, missing/mismatched hook modes, native-to-legacy reset, unavailable auto models, rejected hooks and numeric Codex method-not-found errors. Known unstarted work no longer receives an uncertain-conversation fence. Reviewer restrictions from native administrative requirements are reported. On a live Mac shell probe, native default's outside-fixture read asked once, while acceptEdits's harmless mkdir ran without host approval; Bridge's original policy still asks for every Bash command.

Opus 5.5 completed a final read-only review of the fixes on 2026-10-20 and found no remaining actionable bugs. It checked answer retention after failed shutdown, cancellation after a delivered result, numeric RPC error handling and missing hook-mode rejection. The implementing agent independently ran the final cross-platform checks above. This is source review and test evidence, not a guarantee of compatibility with every native runtime version.

A no-inference capability probe on 2026-10-20 confirmed native account limits through Codex `account/rateLimits/read` and Claude SDK `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`. Claude's method is explicitly unstable. These initial feasibility checks preceded the implemented tools and acceptance below; no account details or usage snapshots are committed.

An isolated Mac ledger with `maxActive: 2` also ran Claude Sonnet 5.5 / requested low effort and Codex GPT-6.1 Sol / medium effort concurrently; both succeeded and their running states overlapped. A follow-up changed that same Claude session to Haiku 5.5 / requested medium effort and correctly recalled a marker from the Sonnet turn. Claude reported the changed model and unchanged session ID, but omitted applied effort, so the effort values remain requested rather than independently verified. The regular shared ledger's concurrency setting was unchanged.

Run `AGENT_BRIDGE_LIVE=1 node --import tsx scripts/live-permissions.ts` after building to repeat the native acceptance. Set `AGENT_BRIDGE_LIVE_RUNTIME=claude` or `codex` for a single runtime; this is an explicit test selection, not a model fallback. It consumes native account usage and writes isolated temporary workspaces plus a local evidence.json. Codex automatic-review testing verifies an actual escalated command succeeds without a Bridge permission response, not just a returned configuration value. These Windows cases run over SSH because they use native file patches and an explicitly escalated command; they do not re-claim general Windows sandbox process compatibility under SSH.

## Usage, account limits and concurrency (2026-10-20)

| Final check | macOS | Ubuntu | Windows |
| --- | --- | --- | --- |
| Automated suite | 139 passed | 139 passed | 138 passed; POSIX trailing-space case skipped |
| Typecheck and build | Passed | Passed | Passed |
| Claude account limits through stdio MCP, without inference | Available | Available | Available |
| Codex account limits through stdio MCP, without inference | Available | Available | Available |
| Real Claude new turn and resumed turn, usage retained | Passed | Passed | Passed |
| Real Codex new turn and resumed turn, usage retained | Passed | Passed | Passed |

Native acceptance used the same installed runtimes and Node versions described above. Each host's isolated MCP client discovered models, selected Claude Sonnet and Codex's default model with reported low effort support, started both jobs and resumed each conversation. All twelve turns succeeded, recalled a random marker without tools and returned persisted native usage through `get_run`. Requested effort is not independently measured. Account probes returned six Claude buckets and one Codex bucket on these accounts; the number is not assumed by the implementation. Account snapshots are read only on explicit request and never stored. The live evidence retains just their status, timestamp, bucket count and experimental flag.

Resume checks retained earlier model token totals and estimated spend rather than summing cumulative snapshots. In the final Mac run, Codex's total rose from 11,063 to 22,173 tokens; its last snapshot was 11,110, so the resumed total includes the prior total plus that snapshot. Claude's native estimated cumulative cost rose from $0.0111767 to $0.0139421. These are telemetry observations, not bills or account-quota deductions. A separate real Mac Codex probe observed `thread/tokenUsage/updated` before `turn/completed`; protocol regressions cover wrong-thread/turn notifications and interrupted partial snapshots.

Schema v4 adds nullable run usage without changing prior idempotency fingerprints. Regression tests cover migration from v3, unknown old usage, persistence through reopen and content pruning, terminal/worker lease fencing, negative or missing counters, zeroed error results and cumulative scope. Storage failures cannot change a native result or interrupt Claude's transcript flush: both adapters have injected-failure tests, and a real SQLite lock held for five seconds leaves the run active with unknown usage until a later write succeeds.

Limits tests cover native request shapes without inference, account-field filtering, denial flags, reset-time conversion, unavailable versus unsupported responses, authentication and timeout errors, empty multi-bucket fallback, cancellation/cleanup and coalescing only pending requests. Claude's SDK quota method remains experimental. Missing or partial native data is not replaced with invented values.

The fixed four-job ceiling is removed; a positive safe integer or `unlimited` is accepted, with the existing default of one preserved. Six separate worker processes can claim independent jobs with no finite limit, while turns sharing a conversation remain queued. A finite limit of six is also enforced. Configuration round trips, queue backoff and bounded tolerance for SQLite contention have regression coverage. This is not a large-scale concurrency soak test or a promise of unlimited machine/account capacity.

Opus 5.5/high reviewed the design, implementation and fixes through Agent Bridge. Its findings about telemetry storage failures, empty Codex bucket maps, falsely available empty quotas and an unverified extra-usage percentage scale were corrected and covered by regressions. Its final read-only review found no remaining blockers, conditional on the final cross-platform checks above, which then passed. Existing native permission acceptance is retained as prior evidence; this change does not claim another exhaustive live run of all permission modes.

After building, repeat the native usage checks with `AGENT_BRIDGE_LIVE=1 node --import tsx scripts/live-usage.ts`. This consumes four short model turns and writes an isolated temporary evidence file. Detailed test logs and private state remain outside committed source.

## Conversation forks (2026-10-20)

| Final check | macOS | Ubuntu | Windows |
| --- | --- | --- | --- |
| Automated suite | 172 passed | 172 passed | 171 passed; POSIX trailing-space case skipped |
| Typecheck and build | Passed | Passed | Passed |
| Real Claude review and write forks through stdio MCP | Passed | Passed | Passed |
| Real Codex review and write forks through stdio MCP | Passed | Passed | Passed |
| Codex goal preflight before fork and fresh-process child resume | Passed | Passed | Passed |

Native acceptance used the installed runtime and Node versions recorded above: Claude Sonnet selected from its catalogue, Codex's configured default model, and reported low effort support. Each runtime used six short turns per host: source, write fork, child follow-up, parent follow-up, review source and review fork. Independent checks confirmed that the child remembered the parent's random marker, retained its own additional marker, wrote only inside its own worktree, and inherited tracked and untracked uncommitted files. The parent's native transcript was unchanged by the fork, and the parent follow-up did not know the child's marker. Repeating the fork request returned the original run. Claude's native cross-worktree copy and resume worked on all three hosts.

The full live script passed twice on all three hosts during implementation. After the final Codex goal preflight was added, the six-turn Codex section passed again on each host. Every Bridge turn opens a new native runtime process, so these checks confirm that `thread/goal/get` works before loading the source or child. Existing Claude live evidence covers its unchanged successful native fork path; the final precheck error mapping is covered by the automated suite. Effort was requested using native catalogue metadata, not independently measured.

Schema v5 adds nullable fork lineage and preserves prior submission receipts. Regression coverage includes source checkpoint transactions, duplicate requests, source reservation and release, multiple forks, child serialization, launch failure and stale-worker recovery. Git checks cover staged/unstaged/deleted/untracked/ignored files, preserving parent index bytes and HEAD, submodules and embedded repositories, agent-configuration changes both committed and uncommitted, inherited Git environment interference, detached HEAD, cancelled preparation and temporary-index cleanup. An 8,100-file fixture exceeds one MiB in both listings and line-ending warnings, with `autocrlf=true` and `safecrlf=warn`; output is streamed without changing that policy.

Protocol tests cover Codex fork identity, unsupported/missing sources, pinned versus pruned turn IDs, workspace roots on fork and resume, and refusing externally assigned goals before opening history. Claude tests cover identity, missing/unreadable history, compaction, failed-turn persistence, pre-dispatch setup failures, post-dispatch initialization uncertainty, source locking and plan-mode selection. A detached Codex fixture worker exercises snapshot preparation, fork, follow-up, failure mapping and reservation release. Real Claude detached-worker coverage comes from the native acceptance script rather than a fake transcript writer.

Opus 5.5/high reviewed the design, implementation and two rounds of corrections. Findings about repository-size limits, compaction, error-state persistence, line-ending warnings and committed configuration changes were fixed with regressions. Its final read-only review found no blockers, conditional on the native unloaded-thread goal check; that check subsequently passed on all three hosts.

Limits specific to this feature: idle successful sources only; no active-turn/earlier-message fork, runtime conversion or workspace-mode change. Compacted history is checked for persistence, not semantic completeness. Repository filters and LFS were not exercised in live acceptance, and there is no dedicated cancellation injection during the streaming listing itself. Git line-ending conversion can change file bytes while preserving Git content. Native transcript retention and concurrent native clients remain outside Bridge's control. Goals set outside Bridge, including paused or completed goals, must be cleared before using a Codex fork. A timeout racing a refusal may still produce an uncertain status requiring inspection.

Repeat with `AGENT_BRIDGE_LIVE=1 node --import tsx scripts/live-fork.ts` after building (twelve short native turns), or set `AGENT_BRIDGE_LIVE_RUNTIME` to one runtime (six turns). Private evidence and transcripts remain outside committed source.

## Limits

- Native acceptance covers the specific Mac, Windows and Linux configurations and models described above. It does not establish compatibility with every shell, operating-system version, model or enterprise policy.
- Sleep handling has a stale-clock/process-identity regression test; no physical laptop sleep test was performed.
- Local job persistence survives client exit, not arbitrary OS termination. No automatic wake-up of an idle host and no exactly-once execution guarantee.
- Worktrees and tool restrictions are not an OS sandbox. Approved commands and trusted repository checkout filters can have broader effects.
- The bridge refuses missing transcripts and incomplete worktrees rather than silently starting fresh or resetting files.
- The plugin packaging is included, but this validation used MCP clients/CLI directly; marketplace installation is not claimed.

Real-model scripts are optional and consume the selected native account usage. Local detailed evidence is ignored under `.local/`; do not commit private transcripts or state directories.
