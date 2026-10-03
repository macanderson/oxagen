# ADR-210: The findings pass reads frames for up to 200 runs and counts the rest

- **Status:** Proposed
- **Date:** 2026-09-27. Amended on 2026-10-02 (#4594): the plan keeps 50
  places for recurring runs. Amended again on 2026-10-02 (#5168): the pass
  reads each recurring group's runs in one query, and that group read
  replaces the run reserve.
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

The pass reads frames for the runs in the window that have a frame source, in
at most 200 reads. Each read is one ClickHouse query. Up to 50 reads go to
recurring groups, and each of them reads all of one group's runs at once (the
#5168 amendment below). The other reads go to single runs, ranked by repeats,
then by cost, then by run id. `frameCoverage` counts the window's runs, the
runs read, the runs no read covers (`capped`), and the runs with no frame
source (`unmatched`). A detector that needs frames reads `capped` before it
treats a run with no frames as a run that spent nothing.

The cap is 200 reads (`FRAME_READS_MAX`). It was 200 runs
(`FRAME_RUNS_READ_MAX`) until a group read could cover many runs. The pass
runs 8 reads at once, so 200 reads is 25 rounds. Every frame a pass reads stays in memory until the
detectors finish, up to 200,000 frames (`FRAME_READ_MAX_FRAMES`). The numbers
are proposals. Nothing has measured a pass's time or memory at 200 reads.

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

The #5168 amendment below replaces this run reserve. This section records why
the reserve existed.

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
- A larger job still could not. The spec's sample job ran 602 times in 7 days,
  about 2,500 runs in the 30-day window, so detector 7 cited it under half
  priced and wrote nothing. The #5168 amendment below prices it.
- In a busy workspace, up to 50 dearer or repeating runs that the ranking read
  before are no longer read.

## Amendment 2026-10-02: one query per recurring group (#5168)

Mac decided this on 2026-10-02, by the test of what holds up with hundreds of
customers (decisions 12 and 13 of the unproductive spend build plan). The run
reserve above read at most 50 of a job's runs, or up to 200 in a quiet
workspace. Detector 7 writes a finding only when half of a group's calls are
priced, so a job of more than about 100 runs got no finding. Reading every run
one query at a time would take about 310 rounds of 8 queries for the spec's
sample job.

The plan now reads each recurring group in one query (`planFrameReads` in
`packages/billing/src/findings-store.ts`):

1. A recurring group is a job of 5 or more runs in the window
   (`RECURRING_RUNS_MIN`), grouped the way detector 7 groups runs: by the first
   prompt's digest, source, and origin, and never a prompt a person sent
   (`runsByJob` in `packages/billing/src/findings/recurring-runs.ts`). This
   replaces the digest-only grouping of the amendment above, so a person who
   starts 5 runs with one prompt takes no group read.
2. A group read is one query over every run's root session and every one of
   its sessions (`readGroupModelCallFrames` in `@oxagen/telemetry`). It joins
   each call's transcript and proxy rows on the call id and the run's root
   session, so one run's call ids never meet another run's. The pass prices
   each run's frames on their own, under the run's own root. So a frame keeps
   the key a read of its run alone gives it (#5156), and its claims stay
   stable from one pass to the next.
3. Up to 50 of the 200 reads go to group reads (`FRAME_GROUP_READS_RESERVE`).
   A group read takes one place, however many runs it covers. A group's runs
   leave the ranking, so no run is read twice. A place no group needs goes
   back to the ranking. The run reserve above (`FRAME_RUNS_RECURRING_RESERVE`)
   is gone, so the plan keeps one reserve.
4. The dearest group goes first, by what all of its runs cost. Two groups of
   one cost go larger first, then by job key. A group read costs one place
   whatever its size, so the order decides which groups are read when a
   workspace has more than 50, and which are read first when the frame cap
   binds.
5. A group read names at most 5,000 sessions (`FRAME_GROUP_READ_SESSIONS`).
   ClickHouse takes query parameters in the request URL and refuses a URL
   over 1 MiB (`http_max_uri_size`). Each root and each session takes about 45
   bytes once encoded, so 5,000 sessions keep the URL under half the limit. A
   group with more sessions takes more reads, one place each. A job's query
   count then grows by one for each 5,000 sessions, not by one for each run.
6. The frame cap stays the memory bound. A group query returns every row of
   its runs at once, so the plan sizes the group reads before they run, by
   each run's model calls in the rollup. All group reads together expect at
   most 200,000 frames. A group whose calls would pass that bound takes its
   runs in rank order while they fit, and the rest go back to the ranking. A
   group whose first run does not fit gets no read.
7. The group reads come first in the read. The read admits a group's runs one
   by one, in order. The first run whose frames would pass the cap stops the
   read, inside a group or after it, as before. So the cap drops single runs at
   the end first.

The pass never prices a frame it did not read. A run the plan or the cap left
unread is cited with no price, as ADR-208 item 10 says, and it pulls its
group's coverage down. If that leaves less than half of a group's calls
priced, detector 7 writes no finding for it.

### Why one query per group

- A cap of runs for recurring jobs grows the query count with the size of a
  job, so the largest customers would get the slowest passes.
- Pricing a sample of a job's runs and scaling the result prices frames the
  pass never read. ADR-208 says a claim is always an exact frame (decision
  13).

### Consequences of the #5168 amendment

- The spec's sample job, about 2,500 runs in the window, is read whole in one
  query, and detector 7 can write its finding.
- A pass still runs at most 200 queries, and holds at most 200,000 frames.
- `frameCoverage` still counts runs, so `read` can pass 200.
- The title's 200 now counts reads. A group read covers many runs.
- A workspace whose recurring jobs hold close to 200,000 frames leaves few
  frames for single runs, such as spin loops. Nothing has measured how many
  frames a busy workspace's recurring jobs hold.
- One group query can return many more rows than a run read. The per-query
  bounds in `COST_FRAME_QUERY_SETTINGS` (128 MiB and 30 seconds) still apply.
  A group read that passes them fails the pass, and the job retries it.
- The reserve of 50 group reads, the bound of 5,000 sessions, and the
  dearest-first order are proposals.
