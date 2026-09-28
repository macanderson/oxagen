# ADR-210: The findings pass reads frames for up to 200 runs and counts the rest

- **Status:** Proposed
- **Date:** 2026-09-27
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
to 200 runs. It ranks runs by repeats, then by cost, then by run id, and reads
the first 200. `frameCoverage` counts the window's runs, the runs read, the
runs the cap left out (`capped`), and the runs with no frame source
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
