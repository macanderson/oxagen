# ADR-028 — Time-travel replay: deterministic session records, bisect, resume, and failure→eval distillation

- **Status:** Accepted
- **Date:** 2026-07-11
- **Owners:** CLI / Evals
- **Relates to:** ADR-023 (session event log), ADR-017 (unified agent engine), Evals v1 (`eval.*` capability family)

## Context

The envelope-v1 event log (ADR-023) made every fleet session an append-only,
replayable-from-seq-1 stream — but only for *rendering*. The log deliberately
bounds itself: tool inputs are capped at 2 KB, tool **outputs are not recorded
at all**, model message history is not persisted, and filesystem state is
reduced to changed-file *names*. A failed run can be re-read, but not
re-examined: you cannot see what a tool actually returned, what the model
actually saw entering turn 3, or what the working tree looked like before the
turn that broke it. Debugging agent failures today is vibes and anecdotes.

Separately, Evals v1 (`eval.dataset.*` / `eval.run.*`) can score datasets, and
`create_trace_dataset` can sample recent metered traces — but nothing routes
*failures* into datasets. Every production failure evaporates instead of
becoming a regression case.

## Decision

**Give every fleet session a deterministic sidecar record — a WAL for agent
runs — and build point-in-time recovery on top of it: replay, bisect, resume,
and automatic failure→eval distillation.**

1. **One sidecar record per session, additive to ADR-023.** The envelope stays
   byte-identical (it is a public contract; nothing here touches it). A session
   directory gains:

   ```
   sessions/<sid>/record/record.ndjson   append-only record log (record-v1)
   sessions/<sid>/record/blobs/<sha256>  content-addressed payload store
   ```

   `record.ndjson` speaks a versioned envelope (`rv: 1`, zod-validated,
   tolerant line parsing — same discipline as ADR-023) with a closed set of
   record types: `run.meta`, `fs.layer`, `turn.start`, `tool.io`, `turn.end`,
   `feedback`, `distill`. Large payloads (tool I/O, model history, file
   contents) live in the blob store, referenced by sha256 — so the record log
   itself stays small, dedup is free (identical outputs share one blob), and
   integrity is verifiable (`ref` must hash to its content).

2. **Record everything determinism needs, uncapped.**
   - `tool.io` — every tool call's **full** input and output (the envelope's
     2 KB cap does not apply; blobs are capped at 2 MB per side with an explicit
     truncation marker carrying the full content's hash and size).
   - `turn.end` — the **full `ModelMessage[]` history** after each turn
     (exactly what the model would see entering the next turn), plus usage,
     steps, and changed files.
   - `fs.layer` — after each turn, the changed files' full post-state (deleted
     files as tombstones). Layer 0 is the baseline: the git HEAD sha plus the
     pre-run content of every dirty file. Restoring turn *k* = detached
     worktree at HEAD + layer 0 + layers 1..k. v1 snapshots changed files, not
     whole sandbox images — see Consequences.
   - Recording is **default-on** for fleet sessions (`OXAGEN_FLEET_RECORD=0`
     disables). A recorder failure disables itself and logs; it must never
     fail or slow the session it observes.

3. **Point-in-time operations, CLI-first** (new `oxagen fleet` subcommands;
   core logic in the framework-free package `@oxagen/replay`):
   - `fleet replay <sid>` — reconstruct the full run from the record with
     integrity verification (every ref resolves and hashes clean, turns
     contiguous, cross-checked against the envelope log). Inspect any turn's
     full tool I/O and diff — the debugger view the 2 KB envelope can't give.
   - `fleet bisect <sid> --cmd <shell>` — `git bisect` for agent runs: binary
     search over turns, restoring the tree at each probe into a scratch
     worktree and running the predicate command; reports the first bad turn
     ("which turn doomed this run?") with its prompt and tool summary.
   - `fleet resume <sid> --turn <k> [--model m] [--prompt p]` — fork a new
     session from the state after turn *k−1*: restored tree + reconstructed
     history, with a different model, prompt, or CLI version. The fork records
     normally, so forks are themselves replayable.
   - `fleet feedback <sid> up|down [-m note]` — human verdict on a finished
     run, appended to the record log (not the envelope — no ownership
     violation, no public-contract change).

4. **Close the loop: failures become evals-v1 cases automatically.** When a
   session ends `failed` — or receives a thumbs-down — the run distills into
   an eval dataset item (`{input, metadata}` per `evalDatasetItemSchema`):
   the original prompt as input; sid, fate, reason, model, error, failing turn
   (when bisected), and changed files as provenance metadata. The item is
   written locally under the session's record dir and pushed to the platform
   through the **existing governed capabilities** (`eval.dataset.create` /
   `eval.dataset_item.add`) via `fleet distill <sid> --push` — metered,
   IAM-gated, tenant-scoped, no new contract surface. A future nightly
   optimizer trains against the exact failures users hit.

## Alternatives considered

- **Fold full payloads into the envelope.** Rejected: the envelope is a public
  additive-only contract sized for tailing and TUI rendering; ADR-023
  explicitly bounds it (coalesced deltas, capped payloads). A sidecar keeps
  the wire format small and the record complete.
- **Record at the platform layer (`agent_executions` steps in Postgres).**
  Rejected for v1: fleet sessions are CLI-local; their tool I/O and tree state
  never transit the platform, and shipping every payload upstream is a
  privacy/e-gress decision users must opt into. The distilled eval item is the
  deliberate, minimal upstream artifact.
- **Re-execute the engine loop against recorded model responses for replay.**
  Deferred to v2 ("harness-in-the-loop replay"): v1's record already contains
  the complete I/O to reconstruct any step bit-for-bit; live re-execution adds
  divergence-handling complexity without changing what v1's users can inspect,
  bisect, or resume.

## Consequences

- Disk: records add roughly the run's I/O volume per session, deduplicated and
  bounded (2 MB/blob cap). `fleet clean` prunes records with their sessions.
- FS snapshots cover files the run changed (plus dirty baseline); artifacts
  produced by build tools outside changed-file tracking are restored by the
  probe command itself (e.g. `pnpm i` in a bisect predicate). Full sandbox
  layer snapshots are the v2 upgrade path.
- `record-v1` is versioned like the envelope: additive within `rv: 1`, golden
  test pins every record type, breaking change bumps `rv`.
- The record contains full tool outputs — potentially sensitive. It stays on
  the user's disk under `~/.oxagen`; nothing leaves the machine except the
  distilled eval item, and only on explicit push (or opt-in auto-push).
