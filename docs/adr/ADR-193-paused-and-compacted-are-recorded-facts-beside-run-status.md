# ADR-193: Paused and compacted are recorded facts beside run status

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** fleet, evidence
- **Related:** issue #3835, PR #4121, ADR-058 (frame compaction), ADR-163
  (command reachability), `packages/oxagen/src/contracts/run.list.ts`
  (`runStatusSchema`, `ingressPaused`, `compacted`).

## Context

Fleet's design lists runs under three chips: live (live and parked), parked
(parked and paused) and sealed (sealed and compacted). Its Status facet
offers compacted, halted, live, parked for approval and sealed. `list_runs`
answers `status` as `live`, `sealed` or `halted`, so no row read as paused or
compacted, and the parked and sealed chips missed those runs.

#3835 proposed widening `status` with `paused` and `compacted`. `status` is
not only a label. About thirty readers treat `status === "live"` as "the run
is open":

- `export_run` refuses a live run, and would export a paused one.
- `run.stream` closes a run's stream when it stops being live, and would
  close a paused run's stream as ended.
- `summarize_run`, `get_run_chain`, `get_run_transcript`, `get_run`,
  `canSummarizeRun`, about twenty Run page sites, the steer dialog and the
  exhaustive `LIFECYCLE_TONE` map all branch on it.
- `list_recent_runs` imports the same enum, and API and MCP consumers switch
  on it.

The record already keeps facts beside the status: `outcome` says how an ended
run ended, and `ingressPaused` says an open run was paused (#4121). The Run
page already derives its "paused" word from `ingressPaused`.

## Decision

1. **`status` keeps three words:** `live`, `sealed` and `halted`. Every
   open-run gate reads it unchanged, and a paused run stays open to all of
   them.
2. **Paused is `ingressPaused`.** A live run whose last applied command paused
   it reads `live` with `ingressPaused: true`. A wrapped session reads the
   last applied pause or resume from `tacho.control_commands`, and a ledger
   run reads its ingress fence.
3. **Compacted is a new fact, `compacted`.** An ended ledger run reads
   `compacted: true` when frame compaction removed its latest sealed attempt's
   hot frames: the seal has an archive segment and no V2 frame of the attempt
   is left in the event log (`compactedProbe`, the same test
   `ledgerCompactedRollupQuery` counts frames by). An archive reference alone
   is not the signal, because every graded seal carries one. A run whose
   earlier attempt was compacted and whose latest attempt still has hot frames
   reads false. An open ledger run reads false.
4. **A wrapped session carries no `compacted` field.** Its store never
   compacts a recording. `tacho.sessions.num_compactions` counts the
   harness's context compactions and is never read for this.
5. **Fleet derives the row words.** `RowState` in
   `apps/app/src/features/fleet/view.ts` adds `paused` and `compacted`.
   Paused wins over parked, as on the Run page, because a paused run takes no
   step whatever its calls are waiting on. The live chip lists live, parked
   and paused. The parked chip lists parked and paused. The sealed chip lists
   sealed and compacted. A paused row links to its Run page, where Resume
   lives, rather than offering an export the server would refuse.

## Consequences

- No consumer of `status` changes, and no API or MCP caller meets a new enum
  value. #3835's literal definition of done ("`list_runs` answers `paused`",
  "`RunStatus` carries both words") is met in substance, not in letter, so the
  issue is referenced rather than closed by the change that lands this.
- A caller that wants the design's words derives them from two fields, the
  way Fleet and the Run page do.
- The live chip lists paused runs, which the design's "live and parked" did
  not name. A paused run is open, and leaving it out of the live chip would
  hide an open run from the one chip that lists open runs.
- The compaction probe costs one indexed `NOT EXISTS` per seal read, served
  by the partial `(attempt_id, attempt_seq)` index.
