# Run backfill from local transcripts

**Status:** Proposed, 2026-09-23. Implements ADR-161 (PR #4017). Implementation issue #4028.

The Run page starts when a host's recorder began shipping. Claude Code keeps a transcript of every session it ran before then, and of every session it ran while the recorder was broken. This spec turns those transcripts into the frames the live recorder would have sealed, marks them as reconstructed, and ships them through the path live frames already use.

ADR-161 owns the decisions: the command runs inside the daemon, frames are deterministic, a backfilled session carries `record_basis = backfill`, git facts are only the recorded ones, cost is estimated, and the Run page claims no governance. This file owns the details an implementer needs: the record-by-record mapping, what cannot be recovered, the CLI contract, the pre-flight, failure handling, and the other three harnesses. Where this file corrects ADR-161, the section says so.

## 1. Source

Claude Code writes one directory per working directory under `~/.claude/projects/`. The directory name is the absolute `cwd` with `/` and `.` replaced by `-`.

| Path | What it holds |
|---|---|
| `<slug>/<sessionId>.jsonl` | The session transcript, one JSON record per line |
| `<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` | One subagent's transcript |
| `<slug>/<sessionId>/subagents/agent-<agentId>.meta.json` | `agentType`, `spawnDepth`, and optionally `model`, `description`, `toolUseId`, `worktreePath`, `spawnedWithWorktree`, `permissionMode` |
| `<slug>/<sessionId>/subagents/workflows/wf_<id>/` | Workflow subagents, with a `journal.jsonl` of `launched`, `started`, `result`, and `failed` records |
| `<slug>/<sessionId>/tool-results/` | Large tool outputs that the transcript references and does not inline |

The backfill reads the first four. It does not read `tool-results/`, `memory/`, `~/.claude/history.jsonl`, `~/.claude/stats-cache.json`, or `~/.claude/sessions/`. A tool output that Claude Code moved to `tool-results/` is digested as the reference the transcript holds, which is also what the live tailer sees.

The survey behind this spec read key names only, on 2026-09-23, across 6,845 transcripts written by Claude Code 2.1.197 through 2.1.281. The largest was 38.7 MB and 12,797 lines.

### Record envelope

Every `user`, `assistant`, `system`, and `attachment` record carries `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`, `isSidechain`, `userType`, and `entrypoint`. Newer versions add `slug`, `session_id`, and `sessionKind`. A subagent's records carry the parent's `sessionId` and their own `agentId`.

An assistant response is split across one line per content block. The lines share `message.id` and `requestId`, `apiBlockIndex` numbers them, and every line repeats the full `usage` object. Usage counts once per `requestId`, which is the rule `llm-call-dedupe.ts` already applies.

## 2. Mapping

`normalizeTranscriptLine` in `packages/tacho/src/claude-code/transcript.ts` already turns most records into drafts. The live recorder gets the rest from hooks (`packages/tacho/src/claude-code/hooks.ts`). A transcript-only chain would miss those, so the backfill adds a synthesizer that derives the hook-sourced frames from transcript records. Every frame the synthesizer produces carries `attrs["oxagen.synthesized_from"]` naming the record it came from, and `source` stays `transcript`.

Every backfilled frame also carries `attrs["oxagen.record_basis"] = "backfill"` and `fidelity = "ambient"` (ADR-161).

### Frames the transcript supports

| Claude Code record | Frame kind | Fields filled | Live source | Producer |
|---|---|---|---|---|
| First timed record of the session file | `agent_start` | `context.cwd`, `context.git_branch`, `context.app_version` from `version`, `context.entrypoint`, `context.session_kind`, `context.permission_mode` from the first `permission-mode` record | `SessionStart` hook | Synthesizer |
| End of a finished file | `agent_stop` | `end_reason = "backfill_end_of_file"`, `ts` of the last timed record | `SessionEnd` hook | Synthesizer |
| `user` with string content, not `isMeta`, not `isCompactSummary`, and no command marker | `turn_start`, then `oxagen:message` | `turn.id` from `promptId`, prompt digest and size, `prompt_origin` from `origin`, `context.permission_mode` from the record | `UserPromptSubmit` hook, transcript | Synthesizer, normalizer |
| `system` with subtype `turn_duration` | `turn_end` | `turn.id` of the open turn, `duration_ms` from `durationMs` | `Stop` hook | Synthesizer |
| Last `assistant` record before the next prompt, when no `turn_duration` closes the turn | `turn_end` | `turn.id`, `stop_reason` from `message.stop_reason` | `Stop` hook | Synthesizer |
| `assistant` (first line of each `requestId`) | `llm_call` | `model`, `message_id`, `request_id`, `stop_reason`, usage by class: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` with the `ephemeral_5m` and `ephemeral_1h` split, `thinking_tokens` from `usage.output_tokens_details`, `server_tool_use` search and fetch counts, `service_tier`, `speed`, `inference_geo`, `iterations`, `context.effort` from `perTurnEffort` or `effort` | Transcript | Normalizer |
| `assistant` (later lines of the same `requestId`) | `llm_call` without usage | `attrs["oxagen.llm_call_duplicate_of"]` | Transcript | Normalizer |
| `assistant` with `isApiErrorMessage`, or `model` equal to `<synthetic>` | `error` | `apiErrorStatus`, `error` | Transcript | Normalizer |
| `tool_use` content block on an `assistant` line | `tool_requested` | `tool_use_id`, `tool_name`, input digest and size, `tool_target` under the live rule | `PreToolUse` hook | Synthesizer |
| `user` with a `tool_result` block | `tool_call` | `tool_use_id`, `tool_status` from `is_error`, `tool_output_digest` from `toolUseResult`, `tool_denial_kind` from `toolDenialKind` | `PostToolUse` hook, transcript | Normalizer |
| `tool_use` named `Agent` or `Task`, joined to a subagent file | `subagent_start` on the parent chain, at the `tool_use` timestamp | `subagent_id`, `subagent_type` and `spawn_depth` from `meta.json`, `tool_use_id` | `SubagentStart` hook | Synthesizer |
| The `tool_result` for that `tool_use` | `subagent_stop` on the parent chain | `subagent_id`, `tool_use_id`, `tool_status` | `SubagentStop` hook | Synthesizer |
| Records of `agent-<agentId>.jsonl` | The child session's own chain, mapped by this same table | `parent_session_uuid`, `root_session_uuid`, `spawn_tool_use_id` | Transcript tailer | Recorder child |
| `system` with subtype `compact_boundary` | `oxagen:compaction` | `trigger`, `preTokens`, `postTokens`, `durationMs` from `compactMetadata` | `PreCompact` hook | Synthesizer |
| `system` with subtype `stop_hook_summary` | `oxagen:hook_health` | `hookCount`, `hookErrors`, `stopReason` | Transcript | Normalizer |
| `system` with subtype `api_retry` | `oxagen:api_retry` | Retry attempt and status | Transcript | Normalizer |
| `permission-mode` | `oxagen:permission_mode_change` | `permissionMode` | Transcript | Normalizer |
| `worktree-state` | `oxagen:worktree` | `context.worktree_path`, `context.worktree_branch` | Transcript | Normalizer |
| `relocated` | `oxagen:cwd_change` | `relocatedCwd` | Transcript | Normalizer |
| `queue-operation` | `oxagen:queue` | `operation`, `reason` | Transcript | Normalizer |
| `pr-link` | `oxagen:pr_link` | `prNumber`, `prUrl`, `prRepository` | Transcript | Normalizer, once #4009 lands |
| `ai-title`, `custom-title` | None. Sets `session_title` in totals, and `custom-title` wins | `aiTitle`, `customTitle` | Transcript | Normalizer |
| `cost-state` | None. Sets totals, and `totalCostUSD` is kept as `harness_reported_cost_usd` for comparison only | `modelUsage`, `totalCostUSD` | Transcript | Normalizer |

The subagent join tries three sources in order:

1. The parent's `tool_result` whose `toolUseResult.agentId` names the subagent.
2. `meta.json` `toolUseId`.
3. `sourceToolUseID` on the subagent's own records.

A subagent with none of the three keeps its parent link and leaves `spawn_tool_use_id` null.

Workflow subagents under `subagents/workflows/` map the same way, and each workflow `journal.jsonl` record is counted and not turned into frames.

### Records the backfill reads and does not map

`attachment`, `file-history-snapshot`, `file-history-delta`, `mode`, `agent-setting`, `agent-name`, `atis-latch`, `bridge-session`, `history-suppression`, `last-prompt`, `frame-link`, `fork-context-ref`, and the `artifact-*` records. Each is counted by type in the report. None becomes a frame, because the live recorder does not turn them into frames either. `fork-context-ref` is read to set `attrs["oxagen.forked_from"]` on the fork's `agent_start` (ADR-161).

### Never produced

A backfilled chain never contains these kinds, and a test asserts their absence. Nothing about them was witnessed, and a guess would read as evidence.

| Kind or field | Why it cannot be recovered |
|---|---|
| `policy_decision`, `approval_request`, `approval_decision` | No policy ran. Claude Code's own permission prompts are not in the transcript. |
| `token_issued`, `token_use`, `token_denied` | No Oxagen credential existed for the session. |
| `steering.manifest` and any context digest | The steering assembler did not run, so there is no manifest of what was included or cut. |
| `proof.observed` | Nothing observed the run from outside. |
| `checkpoint` over the session's lifetime | The device key never saw the chain while it grew. The one checkpoint that covers a backfilled chain is signed at backfill time. |
| `telemetry_gap` for the original run | Nothing was listening, so a gap in the original run cannot be told apart from silence. The backfill emits `telemetry_gap` only for its own read failures (section 6). |
| `instructions_loaded`, `config_change`, `mcp_connection`, `notification`, `elicitation`, `rate_limit`, `auth`, `plugin_install`, `hooks_removed`, `kill_attempted`, `command_applied`, `unobserved_session`, `network`, `file_changed`, `model_switch` | These come from hooks, OpenTelemetry, or the control plane. The transcript does not record them. |
| `agent.enforcement_tier` above `observe` | Nothing gated the run. |
| `env_snapshot`, `settings_sources`, `hooks_registered`, `available_models`, `always_thinking_enabled`, `effort_level_setting` | These come from the `SessionStart` payload and harness settings at the time. Today's settings say nothing about the settings then. |
| `git_head_sha`, `git_dirty`, `git_remote_digest` | ADR-161: the backfill runs no git command, because today's checkout says nothing about the checkout then. |
| Tool execution duration | The transcript has the request and result timestamps and not the execution interval. The Run page may show the difference between them, labelled as elapsed. |
| Maximum thinking budget | Claude Code does not record it. Thinking tokens used are recorded, per call. |

## 3. Provenance and sealing

A backfilled session is reconstructed, not witnessed. Four markers carry that difference, and all four are inside the sealed frames or on the session row.

1. `attrs["oxagen.record_basis"] = "backfill"` on every frame.
2. `attrs["oxagen.synthesized_from"]` on every frame the synthesizer produced.
3. `tacho_sessions.record_basis` set to `backfill`, or `mixed` once a live resume continues the chain.
4. `backfill` in `completeness_gaps`, so the replay grade stays at `inspect` or below (spec §6.3).

The backfill seals each session on the host's own chain, with the same `sealEvent` and the same device key as live frames. It does not use a second key. The device key identifies the host that held the bytes, and a separate backfill key would claim a different witness that does not exist. The chain proves that the record has not changed since the backfill sealed it. The first `checkpoint` signed after the backfill covers the chain head, and its timestamp is the backfill time, not the run time. The Run page says "Sealed at backfill".

Surfaces that present governed evidence refuse a session whose `record_basis` is `backfill`. That covers the evidence export (`tacho export` and the CGP export) and any audit view that lists policy outcomes. The export writes the session with its `record_basis` and does not omit the marker.

## 4. Idempotency and existing chains

### Deterministic ids

ADR-161 derives every envelope field from the transcript bytes, the normalizer version, and the host enrollment id.

- `session_uuid = sessionUuid(<host enrollment id>, <sessionId>)`, the live derivation.
- A subagent's `session_uuid = sessionUuid(<host enrollment id>, "<parent session uuid>/agent/<agentId>")`.
- `event_id = evt_` plus a ULID whose time part is the frame's `ts` and whose random part is the first 80 bits of `sha256(session_uuid, seq, raw_source_digest)`.
- `event_id_idem = eventIdIdem(session_uuid, seq)`, unchanged.
- A synthesized frame's `raw_source_digest` is the digest of the record it came from, plus the synthesized kind, so two frames synthesized from one record differ.

A second pass over an unchanged file seals identical events, and ingest writes nothing new.

### Server pre-flight

This section adds a step ADR-161 does not have.

ADR-161 skips a session only when the local daemon holds a tailer cursor or a registry entry for it. That misses a host whose `TACHO_HOME` was wiped or reinstalled while the server still holds its sessions. The backfill would then send seq 0 for a session the server already holds. Ingest compares a re-sent seq with the stored frame, answers a different hash as a chain break, and sets `chain_verified = false` on the live session for good (`packages/handlers/src/tacho.events.ingest.ts:1150-1170`). A backfill must never break a live chain.

Before it seals anything, the backfill asks the server which of its candidate sessions it already holds. A new read-only capability, `list_tacho_session_heads`, takes up to 500 `session_uuid`s under the host key (`tacho_host_v1`). It returns each one's `seq_count`, `last_hash`, `sealed_at`, and `record_basis`, and only for sessions owned by the calling host. The backfill then decides per session:

| Server state | Local state | Action | Reported as |
|---|---|---|---|
| Unknown | No cursor, no registry entry | Backfill from seq 0 | `backfilled` |
| Unknown | Cursor or registry entry | Skip, the live path owns it | `skipped_local_chain` |
| Known, `record_basis = backfill`, and the same normalizer version | Any | Skip, already done | `skipped_already_backfilled` |
| Known, `record_basis` `live` or `mixed` | Any | Skip, and never fill the gaps | `skipped_server_chain` |
| Known, `record_basis = backfill`, an older normalizer | Any | Skip, and report the version | `skipped_older_normalizer` |

The backfill does not fill gaps in a live chain. The chain is dense by `seq`, so a reconstructed frame cannot be inserted between two witnessed ones without re-sealing the witnessed ones. A live session that lost frames already carries a `telemetry_gap` for them, and that record is the true one. A partly witnessed session stays partly witnessed.

## 5. Transport

Backfilled frames go through the daemon's WAL and shipper to `POST /v1/tacho/events` (`ingest_tacho_events`), as ADR-161 decides. A dedicated backfill capability was rejected. Ingest already verifies chains, stamps the tenant from the key, dedupes on `(session_uuid, seq)`, writes the same tables, and fires the same seal and rollup. A second path would have to repeat all of that and would drift from it.

| Limit | Value | Source |
|---|---|---|
| Events per batch | 200 | `TACHO_MAX_BATCH`, `packages/tacho/src/wire.ts` |
| Bytes per batch | 4 MiB, less a 64 KiB envelope allowance | `wire.ts`, `collector/spool.ts` |
| Requests per host | 120 per minute | `apps/api/src/app.ts` |
| Backoff | From 2 s with 20% jitter, `Retry-After` honoured up to 5 minutes | `collector/spool.ts` |

On the measured host, about 150,000 model calls and 95,000 user records come to roughly 400,000 frames, or about 2,000 batches. At the host rate limit that takes at least 17 minutes of shipping. The shipper drains live sessions first. The backfill stops reading while the unshipped WAL backlog exceeds 64 MiB (ADR-161).

### Attribution

- **Organization and workspace** come from the host key. Every backfilled session lands in the workspace the host enrolled into. The backfill cannot route a session to another workspace, because the key cannot write to one.
- **Workspace choice per directory** is the operator's, through `--project` and `--exclude-project`. A host enrolled into a work workspace should exclude personal project directories. The dry-run report lists each directory by slug and session count so the operator can choose before anything ships.
- **Repository** follows ADR-161: only a recorded live `cwd` to `git_remote_digest` pair on the same host attributes a backfilled session to a bound repository. Otherwise the repository is null.

## 6. Cost

**Correction to ADR-161.** ADR-161's Cost section prices from `packages/billing/src/rate-card.ts`. That file is the undated rate card vendored into the `oxagen` CLI for projections. The control plane prices from the price book, `cost.price_entries`, whose rows are effective over `[effective_from, effective_to)`. `resolvePriceEntry` in `packages/billing/src/price-book.ts` resolves each call at the frame's `ts`. That is already the session's date, so the backfill needs no pricing code of its own.

- The rollup writes `cost_basis = "estimated"` for any session whose `record_basis` is `backfill`, whatever the frames claim.
- A model with no price entry on that date sets `has_unknown_model_cost`, and its calls are left unpriced. They are not priced at today's rate.
- Backfilled cost is excluded from the spend-budget counter and from every Stripe meter (ADR-161).
- Spend and the Run page show backfilled cost with the label "Estimated".
- A backdated price correction reprices backfilled runs through `cost.price-book-reprice`, as it does live ones.

The host holds no price book, so the dry run reports tokens by model and does not report dollars. When the transcripts carry `cost-state`, the report adds Claude Code's own figure, labelled "Claude Code's estimate".

## 7. Command

```
tacho backfill [--since <date>] [--until <date>]
               [--project <slug>]... [--exclude-project <slug>]...
               [--session <id>]... [--dry-run] [--json]
```

| Option | Meaning |
|---|---|
| `--since <date>` | Only transcripts whose first timed record is on or after this UTC date. |
| `--until <date>` | Only transcripts whose first timed record is before this UTC date. |
| `--project <slug>` | Only this directory under `~/.claude/projects/`. Repeatable. |
| `--exclude-project <slug>` | Skip this directory. Repeatable, and applied after `--project`. |
| `--session <id>` | Only this session and its subagents. Repeatable. |
| `--dry-run` | Read, normalize, and run the pre-flight. Seal nothing and ship nothing. |
| `--json` | Print the report as one JSON object instead of a table. |

The command talks to the running daemon over its control socket (`paths.socket`, `packages/tacho/src/host/paths.ts`). The daemon does the reading, sealing, and shipping.

| Exit code | Meaning |
|---|---|
| 0 | The pass finished. Skipped sessions are not failures. |
| 1 | The pass stopped on an error. The cursor file holds the progress so far. |
| 2 | Invalid options. |
| 3 | No daemon is running. The message says the daemon is not running and how to start it. |
| 4 | The host is not enrolled. |

### Report

The dry run and the progress output print counts only. No prompt, message, title, file path inside a transcript, or tool input reaches stdout. A test fails if any transcript text does.

| Field | Content |
|---|---|
| `projects` | Each slug with its session count, subagent count, first and last date, and whether it is included |
| `sessions` | Totals by the actions in section 4: `backfilled`, `skipped_local_chain`, `skipped_server_chain`, `skipped_already_backfilled`, `skipped_older_normalizer`, `skipped_active` |
| `frames` | Count by kind, and the count synthesized |
| `tokens` | By model and token class |
| `harness_reported_cost_usd` | Claude Code's own figure, where `cost-state` exists, with the share of sessions it covers |
| `records_ignored` | Count by record type |
| `drift` | Counts of unknown record types, unknown fields on known types, and sessions from an untested Claude Code version |
| `errors` | Counts of unparseable lines, torn tails, and unreadable files |
| `bodies` | The workspace's body mode, and how many bodies would ship under it |

### Cursor file

The cursor file is `TACHO_HOME/backfill/cursor.json`, written with `writeSensitiveFileAtomic`. ADR-161 calls it `checkpoint.json`. This spec renames it because `checkpoint` is already a frame kind. For each transcript the file records the path, the inode, the head fingerprint (the tailer's `HEAD_BYTES` rule), the bytes read, the last seq, the normalizer version, and the session uuid. A later pass resumes from it. A transcript whose inode or head changed is read again from byte 0, and deterministic frames make that safe.

### Privacy

Bodies follow the workspace's live rule. `prepareContent` (`packages/tacho/src/evidence/frame-body.ts`) redacts and digests every body. A body ships only when `retainsBody` allows it under the workspace's `content_exact` mode, and a body over 1 MiB is omitted with `body_omitted: too_large`. A workspace on `digest_only` receives digests alone. `tool_target` ships under the same rule it ships under live. The backfill uploads nothing the live path would not upload.

The dry run prints the body mode the workspace currently holds. A mode change after the backfill does not reach back to bodies already uploaded.

## 8. Failure and drift

| Case | Handling |
|---|---|
| Final line has no newline | The pass stops before it and leaves the cursor at the last full line. A later pass reads it once it is complete. |
| A line that does not parse as JSON | Counted, skipped, and recorded on the chain as `telemetry_gap` with reason `transcript_line_unparseable` and the byte offset. The pass continues. |
| An unknown record type | Counted under `drift` and skipped. It is never fatal. |
| An unknown field on a known type | Ignored by the normalizer and counted. `attrs` does not absorb it, so a new upstream field cannot carry content past the body policy. |
| A Claude Code `version` outside the tested range | Processed. The session gets `attrs["oxagen.normalizer_untested_version"]` on `agent_start`, and the report counts it. |
| A file written to in the last 15 minutes | Skipped as `skipped_active` (ADR-161). |
| A file removed or truncated mid-pass | That session stops, and the cursor keeps what was sealed. The next pass sees a changed head and starts that file over. |
| A 38 MB, 12,800-line session | Read as a stream, one line at a time, with no whole-file buffer. The `requestId` dedupe set holds 16-byte hash prefixes for one pass, about 5 MB for 300,000 calls, so a fork's copied calls count once across files. |
| A line over 16 MiB | Counted and skipped with a `telemetry_gap`. |
| The daemon restarts mid-pass | The pass stops with exit code 1. Rerunning resumes from the cursor file. |
| Ingest answers a chain break | The session is marked failed in the cursor file and reported. The backfill never retries a session with a different seq 0. |

The tested range is the set of Claude Code versions that have a fixture under `packages/tacho/src/claude-code/fixtures/backfill/`. A new version gets a fixture before the range widens. The mapping keys on field presence, not on version numbers, so a missing field leaves its column null instead of failing the line.

## 9. Other harnesses

ADR-101 requires every harness-facing feature to reach all four wrapped harnesses, or to name the one that cannot and why. ADR-161 puts the other three out of scope. This section records what each keeps on disk, from a key-name survey on 2026-09-23, and whether a backfill can use it.

| Harness | Local source | Backfill | Reason |
|---|---|---|---|
| Claude Code | `~/.claude/projects/` (section 1) | Yes, phase 1 | The mapping above. |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, and `archived_sessions/` | Yes, phase 2 | Each record is `{type, payload, timestamp}`. `session_meta` carries `id`, `cwd`, `cli_version`, `git`, `forked_from_id`, and `parent_thread_id`. `turn_context` carries `model`, `effort`, `approval_policy`, and `sandbox_policy`. `response_item` carries messages, function calls, and their outputs. `token_usage_record` carries `response_id` and usage by class, including `cached_input_tokens`, `cache_write_input_tokens`, and `reasoning_output_tokens`. A Codex normalizer can produce every frame kind in the table above, deduped by `response_id`. The session id takes the recorder's existing `codex/` prefix. |
| Stella | `~/.stella/sessions/ses-<ms>-<pid>.json` and `ses-*/journal.jsonl` | Partly, phase 3 | The journal's `event`, `status`, and `prompt_started` records carry `agent`, `event`, `model`, `role`, and `text`, and can feed `stella-adapter.ts` for turns and tool calls. Per-call usage appears to live in `~/.stella/usage.db`, which the survey could not open read-only. Stella backfill ships turns and tools first. Usage waits until Stella exposes `usage.db` or writes usage into the journal. |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`, a SQLite file, keys `composerData:<id>` in `cursorDiskKV` | Turns only, phase 4 | Each composer record carries `createdAt`, `conversationMap`, `modelConfig`, `usageData`, and `subagentComposerIds`. The format is internal to Cursor and undocumented. `usageData` is a per-composer total, not a per-request record, so the backfill cannot produce an `llm_call` per call and cannot price one. Cursor's live model calls do not pass through the Oxagen gateway either, so its live spend is not metered today. A Cursor backfill produces turns, tool calls, and one session-level usage total, and marks the session's cost as unknown. It reads the file through the `node:sqlite` module built into Node 22.5 and later, so the leaf `@oxagen/tacho` package gains no dependency. |

Each harness gets its own normalizer beside the one it already has (`codex/`, `stella-adapter.ts`, `cursor-adapter.ts`). The command gains `--harness <name>`, defaulting to every harness whose source exists on the host. The provenance, pre-flight, transport, cost, and privacy rules above apply to all four without change.

## 10. Rollout

1. **Recorder changes.** `SessionRecorder` accepts a supplied `event_id`, and the daemon registry can adopt a chain head it did not seal. No behavior change for live frames.
2. **Server changes.** `tacho_sessions.record_basis` and its Atlas migration (`migration-required`), the `list_tacho_session_heads` capability, the estimated basis in the rollup, and the exclusion from budgets and meters.
3. **Claude Code backfill.** The synthesizer, the command, the report, and the cursor file. Ship behind the dry run first. Run `--dry-run` on one host and read the report before the first real pass.
4. **Run page.** The badge, the "Not recorded" governance panels, the "Estimated" label, and "Sealed at backfill".
5. **Codex, Stella, and Cursor** in that order, each in its own PR with its own fixtures.

Steps 1 and 2 can land in either order. Step 3 needs both. Step 4 can land any time after step 2, because a session row with `record_basis` is what it reads.

## 11. Tests

Unit tests only, one file per changed module, run in CI.

- A fixture per row of the mapping table, asserting the kind and fields produced.
- The never-produced kinds are absent from a backfilled chain.
- Two passes over one transcript seal byte-identical frames.
- A session the server already holds is skipped, and nothing is sent at seq 0.
- A pass killed mid-file resumes to one dense chain with no repeated seq.
- A backfilled session resumed live continues at the next seq, and `record_basis` becomes `mixed`.
- A fork's copied `requestId` counts once across two files.
- A torn final line, an unparseable line, an unknown record type, and an untested version each follow section 8.
- No transcript text reaches stdout in dry run or progress output.
- The rollup writes `estimated` for a backfilled session and adds nothing to the budget counter.
- The Run page component renders the badge, the panels, and the labels for a backfilled session.

## 12. Definition of done

The implementation issue, #4028, holds the checklist. A PR that finishes a phase in section 10 cites it with `Refs #4028`. The PR that finishes the last Claude Code item closes it. Codex, Stella, and Cursor each get their own issue when their phase starts.
