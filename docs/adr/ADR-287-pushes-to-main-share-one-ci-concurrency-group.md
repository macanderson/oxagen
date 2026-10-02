# ADR-287: Pushes to main share one CI concurrency group

- **Status:** Accepted
- **Date:** 2026-10-02
- **Owners:** platform
- **Decided by:** the maintainer, 2026-10-02, after the run data below showed
  what the per-commit group cost.
- **Supersedes:** ADR-046
- **Related:** issue #5248, #5247, #4552, #4259, #2730, ADR-164, ADR-218,
  `.github/workflows/pipeline.yml` (`concurrency:`, `publish-installers`),
  `tools/scripts/check-main-concurrency.mjs`,
  `tools/scripts/check-deploy-tip.mjs`

## Context

GitHub runs one workflow run per concurrency group at a time and keeps one
more waiting. A newer run replaces the waiting one, which concludes
`cancelled` without starting. With `cancel-in-progress: false`, nothing
cancels the run that is going.

ADR-046 gave every push to `main` its own group, keyed by commit. It said a
shared group had starved `main` on 2026-09-07: each merge replaced the waiting
run, the chain never ended, nothing finished after `40585e52` at 19:23 UTC, and
eight commits never deployed.

### What the run history shows

`main` already had `cancel-in-progress: false` that day, so the running run
always finished, and the newest waiting push started next. The CI runs for
pushes to `main` on 2026-09-07 show exactly that:

| Commit | Queued (UTC) | Finished (UTC) | Result |
|---|---|---|---|
| `40585e52` | 18:08 | 19:23 | success |
| `7981bdd5` | 18:55 | 20:38 | success, every service deployed |
| `ee94b012` | 20:21 | 21:41 | success, every service deployed |
| `265ed60e` | 21:27 | 22:35 | success, every service deployed |

Run 34153586425 (`7981bdd5`) packaged the app and ran `ship-to-node` in
`deploy app.oxagen.sh`, so the deploys were real. Each queued run started when
the one before it finished and took 54 to 75 minutes. The runs it replaced
concluded `cancelled`. The one checked, for `d5a888e1`, has no jobs, so it
never started and cost nothing. The shared group did what it should: one run
at a time, each covering every merge since the last.

### What the per-commit group cost

From 2026-09-25 to 2026-10-02, pushes to `main` started 541 CI runs that used
about 34,300 job-minutes. Every merge ran the full gate, and several ran at
once:

- On 2026-09-21, 15 `main` runs waited behind 2 in progress
  (`check-main-preflight.mjs`), and on 2026-09-27 four `main` runs waited over
  an hour for runners (#4552).
- With several `main` runs in flight, an older commit's run shipped its API
  after a newer commit's run had renamed tables it reads. Production steering
  calls failed until a newer run shipped (#5247).
- Preflight skips the gate only when a newer commit already exists when the
  run starts. A per-commit run starts as soon as its push lands, when it is
  almost always the tip, so preflight rarely skipped anything.

Replaying the same push times with one shared group starts 158 runs and uses
about 10,800 job-minutes, about two-thirds less. That figure is rough. A run
covering several merges can select more packages than any one of them, and
since 2026-10-01 most jobs run on our own EC2 runners (`CI_RUNNERS=aws`), so
the saving is EC2 time more than GitHub minutes.

## Decision

**Pushes to `main` share one CI concurrency group, `ci-refs/heads/main-push`,
and `cancel-in-progress` stays true for pull requests only.**

```yaml
group: >-
  ci-${{ github.ref }}${{
    github.event_name == 'push' && github.ref == 'refs/heads/main'
      && '-push' || ''
  }}
cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

- A running `main` run always finishes, so `migration-gate` is never cut off
  mid-apply.
- The newest waiting push starts as soon as the running run finishes. It
  checks and ships every merge since the run before it.
- `main` runs finish in commit order, so an older commit cannot deploy after a
  newer one's migration through this path.
- A manual dispatch on `main` keeps the plain `ci-refs/heads/main` group. A
  dispatch skips the gate, so letting it replace a waiting push run would
  leave the newest commit unchecked until the next merge.
- Pull requests and merge queue runs keep their groups by ref, unchanged.

`publish-installers` used the push's own range (`github.event.before`) to
decide whether the desktop app changed. One run now covers several merges, so
it diffs from the commit whose installers were last built instead. The
`order` step already reads that commit from the `desktop` record, and
`check-deploy-tip.mjs` now writes it as the `live` output. With no record,
the step falls back to the push's own range.

## What it costs

- **Merge to production can take longer.** A merge that lands just after a
  run starts waits for that run, then for its own. The worst case is about two
  run lengths. Before, a merge started its own run at once, when a runner was
  free.
- **Not every commit gets its own run.** `check-main-verified.mjs` already
  marks a commit covered by a later finished run as `superseded` and raises
  nothing for it. Bisecting by run history finds gaps, and a failed run can
  cover several merges, so finding the breaking one means reading their diffs.
- **Preflight can still skip a run.** A push can land between a run starting
  and its preflight job asking. Preflight then skips the gate, and the waiting
  run covers the commit. #4259 tracks the case where that covering run fails
  early.

## Why not the alternatives

**Cancelling the running run on `main`.** A full run takes 60 to 75 minutes
and merges land every 10 to 20, so every run would be cancelled before it
finished and nothing would deploy. GitHub bills the time a run spent before
it was cancelled. It would also cut `migration-gate` off mid-apply.

**Keeping the per-commit group and relying on preflight.** Preflight only
skips when a newer commit exists at the start, which a per-commit run almost
never sees. The 541 runs above are that setup.

**A scheduled deploy every hour.** GitHub often starts scheduled runs late,
and a run that finds nothing to ship still bills its minimum. The per-service
`production-*` deploy groups and ADR-164 already queue deploys on each run,
with no polling.

## Consequences

- `tools/scripts/check-main-concurrency.mjs`, wired into `check:contracts`,
  now fails three shapes: a group keyed by `github.sha`, a group that lets a
  manual dispatch share the push group, and a `cancel-in-progress` that can
  cancel a push run. Its unit tests carry a witness for each, including the
  per-commit group ADR-046 shipped.
- `tools/scripts/check-deploy-tip.mjs` writes `live` next to `ship`.
- `tools/scripts/check-main-verified.mjs` reads a commit whose run a newer
  push replaced as `awaiting_cover` while a later run is still going, for up
  to three hours. `awaiting_cover` counts as pending. Without it, every burst
  of merges would file a `MAIN-UNVERIFIED` issue and close it again when the
  later run finished. A commit older than three hours with no finished run
  after it still files one.
- ADR-046 is superseded.
- Not customer-facing. This is CI and ops, with no user-facing documentation
  changes.
