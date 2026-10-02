# ADR-210: The findings pass reads frames for up to 200 runs and counts the rest

- **Status:** Proposed
- **Date:** 2026-09-27. Amended on 2026-10-02 (#4594): the plan keeps 50
  places for recurring runs.
- **Owners:** billing, spend
- **Related:** ADR-062 (the findings job and its detectors), ADR-208
  (unproductive spend counts each frame once), the unproductive spend build
  plan (lane F1b, and lanes F6, F7, F8, F10, and F11 that read its fields).

## Context

Detectors 3 to 8 each need something the findings pass did not read. A
detector for a run that changed nothing needs the run's first prompt and
whether it changed a file. A cache detector needs each frame's tokens and
price per class. A context detector needs each frame's system context digest
and its parts. A compaction detector needs the run's compactions. The
no-outcome detector needs the run's pull request outcomes.

The pass read model-call frames only for runs with a repeated tool call, at
most 200 of them (ADR-208). A detector that looks at every run saw no frames
for most runs, and it could not tell a run with no frames from a run the pass
did not read.

## Decision

The pass reads these per run, once, into `DetectInput`:

| Field | Source | Asked for by |
|---|---|---|
| `firstPrompts` | the first `turn_start` frame with a prompt on the root's chain, `tacho_events` | F6 |
| `fileChanges` | `tacho.session_files`, by the rule `sessionChangedFilesWhere` applies, plus a digest change | F6 |
| `compactions` | `oxagen:compaction` frames, a hook's `PostCompact` frame alone, `tacho_events` | F8 |
| `outcomes` | `cost.run_pr_outcomes` | F11 |
| `frameCoverage` | the frame plan below | every lane |

Each priced frame also carries its model, its tokens and price entry per
class, its tool-definition, context-frame, and steering tokens (#4493), and
its system context digest and parts (F7, F10). A finding may carry a
`recommendation`, a setting with the value the fix proposes (F7).

The pass reads frames for every run in the window that has a frame source, up
to 200 runs. It ranks runs by repeats, then by cost, then by run id. The first
150 places go by that ranking. The other 50 go first to recurring runs the
ranking left out, and any place they do not need goes back to the ranking (the
2026-10-02 amendment below). `frameCoverage` counts the window's runs, the runs
read, the runs the cap left out (`capped`), and the runs with no frame source
(`unmatched`). A detector that needs frames reads `capped` before it treats a
run with no frames as a run that spent nothing.

The cap is 200, the value `FRAME_RUNS_READ_MAX` already held. One run's frame
read is one ClickHouse query, and the pass runs 8 at once, so 200 runs is 25
rounds of reads. Every frame a pass reads stays in memory until the detectors
finish. The number is a proposal. Nothing has measured a pass's time or
memory at 200 runs.

Every new field is optional on `DetectInput` and on `PricedRequestFrame`.
Detector tests and other packages build those types as literals, and a
required field would break each of them. The store builds `DetectReads`,
which requires every read, and `detectInputFixture()` gives a detector test
the same shape with empty defaults.

## Consequences

- A detector gets frames for runs with no repeat, so it can price a run that
  changed nothing, or a run with no outcome.
- A pass reads up to 200 runs' frames where it read only the runs with a
  repeat. In a workspace with few repeats, a pass reads more.
- A run past the cap has no frames. `frameCoverage.capped` says how many, so
  a detector or a reader can name the gap.
- The first prompt keeps a slash command, with its name. A detector that
  wants typed text alone filters on `source` and `commandName`.
- Nothing writes `digest_before` or `digest_after` yet. Until something does,
  the digest clause of the file-change rule matches nothing.

## Amendment 2026-10-02: places for recurring runs (#4594)

Recurring runs (detector 7, lane F6) price a scheduled job's runs from their
frames. A job's runs are cheap, and they rarely repeat a call. So in a
workspace with more than 200 runs that cost more or repeat a call, the ranking
above read none of them. Detector 7 then cited each of their calls unpriced,
the group's priced share fell under half, and the pass wrote no finding.

The plan now keeps places for them (`planFrameReads` in
`packages/billing/src/findings-store.ts`):

1. A run is recurring when its first prompt digest started 5 or more of the
   window's runs (`RECURRING_RUNS_MIN`). The pass reads each run's first
   prompt before it plans, so the plan knows each digest.
2. The ranking above fills the first 150 places: the limit less
   `FRAME_RUNS_RECURRING_RESERVE`, which is 50.
3. The 50 reserved places go to the recurring runs the ranking left out,
   smallest group first. Detector 7 writes a group only when at least half of
   its calls are priced, so reading small groups whole writes more findings
   than reading part of a large one. Two groups of one size go by digest, and
   one group's runs keep their rank.
4. A reserved place no recurring run needs goes to the next run in the
   ranking. A workspace with no recurring prompt reads the same 200 runs as
   before.
5. The reserved runs come first in the read. When the frame cap (200,000
   frames) stops the read, it drops ranked runs at the end and keeps these.

### Why a reserve

- A sort key for recurring runs between repeats and cost still reads none of
  them when 200 runs repeat a call.
- A sort key ahead of repeats lets one hourly job fill all 200 places. Spin
  loops, 10.9% of the spec's sample against 1.8% for recurring runs, would
  then get no frames, and neither would any other detector that reads them.
- A reserve bounds both sides. Recurring runs get up to 50 places, and the
  ranking keeps at least 150.

The plan groups runs by the digest alone. Detector 7 also splits a digest by
the prompt's source and origin, and leaves out a prompt a person sent. Each of
its groups sits inside one digest group, so the plan misses none of them. A
person who starts 5 runs with one prompt takes reserved places too, and those
runs' frames still serve every other detector.

The reserve of 50 is a proposal. A daily job, 30 runs in the window, fits
whole with room for a smaller one. Nothing has measured how many recurring
prompts a busy workspace has.

### Consequences of the amendment

- A job of up to 50 runs in the window is read whole, and a job of up to about
  100 can reach half of its calls priced.
- A larger job still cannot. The spec's sample job ran 602 times in 7 days,
  about 2,500 runs in the 30-day window, so detector 7 cites it under half
  priced and writes nothing. Pricing a job that large needs a decision, which
  #5168 records.
- In a busy workspace, up to 50 dearer or repeating runs that the ranking read
  before are no longer read.
