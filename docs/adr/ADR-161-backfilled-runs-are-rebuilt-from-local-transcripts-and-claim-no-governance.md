# ADR-161: Backfilled runs are rebuilt from local transcripts and claim no governance

Status: Accepted
Date: 2026-09-23
Related: ADR-043, ADR-058, ADR-060, ADR-064, ADR-084, ADR-099, ADR-113, ADR-162
Refs: #4013

## Context

Your Run history starts the day the host enrolled. Every Claude Code session that ran before then is missing, although Claude Code kept its transcript. On the host this was measured on, `~/.claude/projects/` holds 171 project directories, about 6,800 session transcripts, and 6.1 GB.

Each project directory holds `<session>.jsonl`, one JSON record per line. A session that spawned subagents also has `<session>/subagents/agent-<id>.jsonl`, and each of those has an `agent-<id>.meta.json` beside it. A sample of the files on 2026-09-23 showed these shapes. Only key names were read.

| Record `type` | What it carries |
|---|---|
| `user`, `assistant` | `message` (with `usage`, `model`, and `requestId` on an assistant record), `promptId`, `toolUseResult` on a tool result, `sourceToolUseID` and `sourceToolAssistantUUID` on records a tool produced |
| `system` | `subtype`, `durationMs`, and `messageCount` for a turn duration; `compactMetadata` for a compaction |
| `attachment`, `queue-operation`, `file-history-snapshot` | Context the harness attached, queued prompts, and file snapshots |
| `ai-title`, `agent-name`, `last-prompt` | The session title, the agent name, and the last prompt with its `leafUuid` |
| `permission-mode`, `mode`, `agent-setting` | Settings as they changed |
| `pr-link` | `prNumber`, `prUrl`, and `prRepository` for a pull request the session opened |

Message records also carry `cwd`, `gitBranch`, `version`, `effort`, `perTurnEffort`, `isSidechain`, `slug`, `uuid`, and `parentUuid`. A subagent's lines carry `agentId`, and their `sessionId` is the parent's. Its `meta.json` carries `agentType`, `description`, `model`, `name`, `permissionMode`, and `spawnDepth`. When the parent's tool call returns, the parent's `toolUseResult` names the subagent's id.

Most of the code a backfill needs already exists:

- `normalizeTranscriptLine(line, fallbackTs)` in `packages/tacho/src/claude-code/transcript.ts` turns one line into `TranscriptDraft`s and running `TranscriptTotals`. Each draft carries `raw_source_digest`, the digest of the source line.
- `SessionRecorder.ingestTranscriptLine(line, subagentId?)` in `packages/tacho/src/claude-code/recorder.ts` seals those drafts with `source: "transcript"`. It routes a subagent's lines to a child recorder, whose `session_uuid` is `sessionUuid(scope, "<parent session uuid>/agent/<subagent id>")`.
- `packages/tacho/src/collector/transcript-tailer.ts` keeps one byte cursor per transcript and persists it, so a daemon restart does not seal a line twice.
- `sealEvent` in `packages/tacho/src/chain.ts` assigns the dense `seq`, `event_id_idem = eventIdIdem(session_uuid, seq)` from `packages/tacho/src/ids.ts`, `prev_hash`, and `hash = sha256(JCS(event without hash))`.
- The host's write-ahead log lives under `TACHO_HOME` (`wal/`, see `packages/tacho/src/host/paths.ts`), and the shipper sends it to `ingest_tacho_events` (`packages/oxagen/src/contracts/tacho.events.ingest.ts`) in batches of at most `TACHO_MAX_BATCH = 200` events.

Two facts shape the design.

First, `event_id` is not deterministic today. The recorder sets `event_id: newEventId(Date.parse(fields.ts))`, a ULID with random bytes, and the hash covers `event_id`. A second pass over the same file would produce the same `event_id_idem` with a different hash. The ingest handler compares a re-sent seq with the frame ClickHouse holds, and it answers a different hash as a chain break. A re-run built on today's recorder would break chains rather than deduplicate.

Second, the session identity is `sessionUuid(<host enrollment id>, <harness session id>)`. A backfill and a later live tail of the same transcript derive the same `session_uuid`. If each started its own chain at seq 0, the two would collide on every seq.

## Decision

### Command

`tacho backfill [--since <date>] [--project <dir>] [--dry-run]` is a Tacho CLI command. It asks the running daemon to do the work over the daemon's local control socket (`paths.socket` in `packages/tacho/src/host/paths.ts`). The daemon owns the host key, the recorders, the tailer's cursors, the WAL, and the shipper, and a second writer to any of them would race it. With no daemon running, the command refuses and says to start it.

- `--since <date>` limits the pass to transcripts whose first record is on or after the date. The default is every transcript.
- `--project <dir>` limits the pass to one directory under `~/.claude/projects/`. The option can repeat.
- `--dry-run` reads and normalizes locally, seals nothing, and ships nothing. It prints counts only: projects, sessions, subagents, lines, model calls, total tokens by model, and the estimated cost. It prints no prompt, message, title, or path inside a transcript.

Progress prints the same counts. The command prints no transcript content in any mode.

### Session identity and the shared chain

A backfilled session uses the same identity a live session would: `sessionUuid(<host enrollment id>, <harness session id>)`, and the recorder's existing child derivation for a subagent. The backfill runs each transcript through a `SessionRecorder` in the daemon. It persists that recorder's chain head (seq and prev hash) in the daemon's session registry, and it persists the tailer's byte cursor at the end of what it read.

If the session resumes later with the collector installed, the hook finds the registered session and the tailer finds the cursor. The live recorder continues the backfilled chain at the next seq, and the tailer starts reading at the next unread byte. The live tail seals no line a second time, and the session has one chain.

A session the daemon has already registered (it has a tailer cursor or a registry entry) is skipped by the backfill, because the live path owns it. A transcript written to in the last 15 minutes is skipped as possibly active. A later pass picks it up.

The chain starts fresh at seq 0 for each backfilled session. It proves the record has not changed since the backfill sealed it. It does not prove anything about the run itself, and the Run page says so.

### Deterministic frames

Every field of a backfilled envelope is a function of three inputs: the transcript bytes, the normalizer version, and the host enrollment id. Nothing reads the clock, the checkout, or a random source.

- `event_id` for a backfilled frame keeps the live shape, `evt_` plus a ULID. The time part comes from the frame's `ts`, and the random part comes from `sha256(session_uuid, seq, raw_source_digest)`. The recorder gains a way to take a supplied `event_id`. The live path keeps `newEventId`.
- `ts` is the line's `timestamp`. A record with none (`ai-title`, `mode`, and the other settings records) takes the timestamp of the last timed line before it, which is what `fallbackTs` already does.
- `seq` is the dense order in which drafts leave the normalizer, reading the file from byte 0.

A second pass over an unchanged file, with the same normalizer, produces identical events. Each gets the same `event_id_idem` and the same hash, and ingest writes no second row. The checkpoint (below) records the normalizer version. A pass under a newer normalizer does not re-seal a session sealed under an older one. It reports the session as sealed under version N and leaves it.

### Marking a backfilled record

- `source` stays `transcript`, which is where every backfilled frame came from.
- Every backfilled frame carries `attrs["oxagen.record_basis"] = "backfill"`. The attrs are inside the hash, so the marker is part of the sealed frame.
- `fidelity` stays within `TACHO_FIDELITIES`. A backfilled frame takes `ambient`, the value for a frame the harness did not hand to Tacho through a hook. No new fidelity value is added, because fidelity describes the channel, and the channel is the transcript in both cases.
- `tacho.sessions` gains `record_basis text not null default 'live'`, constrained to `live`, `backfill`, and `mixed`. A session that a live resume later continued reads `mixed`. The implementation PR carries this column and its Atlas migration, labelled `migration-required`.
- The seal adds `backfill` to `completeness_gaps`. The spec (§6.3) grades a gap outside the vocabulary `inspect`, and a backfilled session grades no higher than that. `enforcement_tier` is `observe`: nothing was gated.
- The backfill seals `agent_stop` with `end_reason = "backfill_end_of_file"`, so the session closes and its rollups run. A live resume continues after it.

### Git facts

The only git facts a backfilled session carries are the `gitBranch` and `cwd` its own lines recorded. `git_branch` and `cwd` on the session row come from the first message record. `git_head_sha_start`, `git_head_sha_end`, `git_dirty_start`, and `git_remote_digest` stay null. The backfill reads no `.git` directory and runs no git command, because today's checkout says nothing about the checkout at the time of the run. Frames carry `attrs["oxagen.git_basis"] = "recorded"`, and the Run page labels the branch "recorded by Claude Code".

### Subagents, resumes, and forks

- A subagent transcript is fed through the parent's recorder with its `agentId`, as the live tailer does after `SubagentStop`. The child's `parent_session_uuid` is the parent, and `root_session_uuid` is the parent's root. `subagent_type`, `subagent_description`, and `spawn_depth` come from `meta.json`. `spawn_tool_use_id` is the id of the parent's tool call whose `toolUseResult` names that `agentId`, or the `sourceToolUseID` on the subagent's records when the result is missing. A subagent with no matching parent record keeps its parent link and leaves `spawn_tool_use_id` null.
- A resumed session appends to its own file and stays one session.
- A forked session is a new file with a new session id whose leading records repeat another session's record `uuid`s. The backfill records the source session as `attrs["oxagen.forked_from"]` on the fork's `agent_start`. It counts a copied assistant record's usage once per host, keyed by `requestId`, so a fork does not double the spend.

### Cost

The host ships usage, not cost. The control plane prices each backfilled `llm_call` from `packages/billing/src/rate-card.ts` at the price in effect on the call's `ts`, and writes `cost_basis = "estimated"` (already in `COST_BASES`, and already handled by `packages/billing/src/cost-rollup-store.ts`). A model the rate card cannot price sets `has_unknown_model_cost`. Backfilled cost does not add to the spend-budget counter (ADR-060 §5), does not reach a Stripe meter, and does not count toward a current budget. The Run page and Spend show it with the label "Estimated".

### Workspace and repository

Ingest takes the tenant from the host key (`tacho_host_v1`), so every backfilled session lands in the workspace the host enrolled into. The backfill does not choose a workspace.

A session is attributed to a repository only when its recorded `cwd` equals the `cwd` of a live session on the same host that recorded a `git_remote_digest`, and that digest matches a repository bound to the workspace through `ingestion.repository_binding_heads`. Otherwise its repository stays null, and the Run page shows it as unattributed. The backfill does not read a remote from disk.

### Batching, rate, and resume

- Backfilled frames go through the WAL and the existing shipper, so they get the same retry, body shipping, and 200-event batches as live frames.
- The shipper drains live sessions before backfilled ones. The backfill pauses reading while its unshipped WAL backlog exceeds 64 MiB, so a live session waits for at most one backfill batch.
- A 429 or 503 from ingest backs off with the shipper's existing policy. The backfill adds no retry loop of its own.
- The checkpoint is `TACHO_HOME/backfill/checkpoint.json`, written atomically with `writeSensitiveFileAtomic`. For each transcript it records the path, inode, a fingerprint of the first bytes (the tailer's `HEAD_BYTES` rule), the bytes read, the last seq, the normalizer version, and the session uuid. An interrupted pass resumes from it. A transcript whose inode or head changed is read again from byte 0, and deterministic frames make that safe.

### Privacy

Backfilled bodies follow the live rule. The recorder redacts content as it does for a live frame. The shipper sends a body only when `retainsBody` allows it under the workspace's `digest_only` or `content_exact` mode (`packages/tacho/src/wire.ts`). A workspace on `digest_only` receives digests alone. The backfill uploads nothing the live path would not upload.

### Run page

A backfilled run shows a "Backfilled" badge in the header with one line beneath it: "Rebuilt from the Claude Code transcript on <date>. Nothing was enforced during this run." The governance panels (policy decisions, elevations, mandate, and enforcement tier) show "Not recorded" in place of a value. The cost reads "Estimated". The chain status reads "Sealed at backfill", not a verified-since-start claim. Fleet and the operator review may read backfilled runs, and they carry the same badge wherever a run is listed.

## Consequences

You can see sessions that ran before enrollment, with their turns, tools, tokens, subagents, and estimated cost.

A backfilled run proves less than a live one. Nothing gated it, its chain starts at the backfill, its cost is estimated, and its repository may be unattributed. The badge and the `record_basis` column carry that difference to every surface that reads the run.

The first pass on a host like the measured one ships about 6.1 GB of transcript through the normalizer. Most of that is attachments and snapshots the normalizer does not turn into frames, and bodies ship only under `content_exact`.

The live recorder gains an injectable `event_id`, and the session registry gains the ability to adopt a chain head it did not seal. Both are small changes to shared code, and both need tests.

Transcripts from harnesses other than Claude Code are out of scope, because `transcript.ts` has no normalizer for them.

## Definition of done

- [ ] `tacho backfill` with `--since`, `--project`, and `--dry-run` in the Tacho CLI, calling the daemon over its control socket, and refusing when no daemon runs.
- [ ] Dry-run and progress output print counts only, with a test that fails if any transcript text reaches stdout.
- [ ] `SessionRecorder` accepts a supplied `event_id`. Backfilled frames derive it from `session_uuid`, seq, and `raw_source_digest`. A test seals one transcript twice and asserts identical events.
- [ ] The daemon registry adopts a backfilled chain head and the tailer cursor. A test backfills a transcript, resumes the session live, and asserts one chain with no repeated line.
- [ ] Sessions with a tailer cursor or registry entry, and transcripts written to in the last 15 minutes, are skipped.
- [ ] Subagents link to their parent through `agentId`, the parent's `toolUseResult` or `sourceToolUseID`, and `meta.json`. Forks carry `oxagen.forked_from` and count copied usage once per `requestId`.
- [ ] `tacho.sessions.record_basis` with its Atlas migration and constraint. The seal writes `backfill` into `completeness_gaps`, and `enforcement_tier` is `observe`.
- [ ] Git facts come from recorded `gitBranch` and `cwd` only, with `oxagen.git_basis = recorded`. A test asserts no git process is spawned.
- [ ] The control plane prices backfilled usage from the rate card with `cost_basis = "estimated"`, and backfilled cost is excluded from the spend-budget counter and Stripe metering.
- [ ] Repository attribution uses only a recorded live `cwd` to `git_remote_digest` pair on the same host.
- [ ] WAL backlog cap, live-first shipping, and the checkpoint file with resume after interruption, each covered by a test.
- [ ] The Run page badge, the "Not recorded" governance panels, the "Estimated" cost label, and the chain status wording, covered by a component test.
- [ ] `docs/specs/tacho/spec.md` and `data-model.md` describe `record_basis`, the `backfill` gap, and the command. The published CLI reference documents `tacho backfill`.
