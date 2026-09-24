# ADR-164: Every green commit ships unless a newer one is already live

- **Status:** Accepted
- **Date:** 2026-09-24
- **Owners:** platform
- **Related:** ADR-046 (a concurrency group per commit on main), #2874 (a stale
  deploy moved production backwards), #2730 (evicted queued runs), #3953 (main
  red and undeployed)

## Context

A main run takes 60 to 70 minutes: checks and tests, then staging, then
migration-gate, then the deploy jobs. Since #2874, each deploy job shipped its
commit only if that commit was still the tip of main when the job started.
That stopped an older run that finished late from overwriting a newer deploy.

It also meant a deploy happened only if nobody merged for the length of a run.
On 2026-09-24 main went green at e111db5. Three merges landed while its staging
jobs ran, so its deploy jobs would have skipped. Every later run was exposed to
the same thing. Production stayed on a commit from the previous evening while
main moved ahead of it, and releasing fixes one after another required everyone
to stop merging.

## Decision

A deploy job ships its commit unless a newer commit is already live for that
service.

- After a real deploy, the job records the commit it shipped as a GitHub
  deployment: environment `production`, task `deploy:<service>`.
- Before deploying, the job reads the newest record for its service and asks
  the compare API how its commit relates to it:

| Relation to the live commit | Decision |
|---|---|
| ahead (descends from it) | ship |
| identical (a re-run) | ship |
| behind (the live commit descends from this one) | skip. This is the #2874 case. |
| diverged (main was reset) | ship only if this commit is main's tip now |
| nothing recorded yet | ship |
| the API cannot answer | ship, with a warning |

- Each deploy job holds the concurrency group `production-<service>` with
  `cancel-in-progress: false`. A deploy in flight always finishes, and two runs
  never ship the same service at once, so the record cannot race. When several
  runs wait for the same service, GitHub keeps only the newest pending job. That
  is the one worth shipping.
- `preflight` still skips the gate for a commit that a later push already
  superseded before the gate started. The later run carries that commit's
  changes and ships them.

`tools/scripts/check-deploy-tip.mjs` implements the rule and its tests replay
both incidents. Its `--guard` mode, part of `check:contracts`, fails if a deploy
job loses:

- the order step;
- the gate on any later step;
- the record step;
- the per-service lock.

## Consequences

- A burst of merges no longer starves production. Each run that finishes its
  gate ships, unless a newer run for the same service shipped first. Production
  follows main's tip within about one run's length.
- Production still never moves backwards. The #2874 ordering case skips, as
  before.
- A newer pending run replaces an older one that is waiting for the same
  service's lock. The replaced job reads as cancelled. `deployment-failure`
  classifies a cancelled run as `none`, so it files no P0 issue.
- A failed record step only warns. The next run compares against an older
  record, finds itself ahead, and ships, which is safe.
- The first deploy after this change finds no record and ships, which starts
  the record.
- `manual-app-deploy`, the break-glass path, does not read or write the record.
  A later pipeline run is ahead of whatever it shipped and ships over it.
- Batching merges through GitHub's merge queue (`merge_group` is already wired
  in `pipeline.yml`) remains a separate choice. It lowers how often main goes
  red, and this rule does not depend on it.
