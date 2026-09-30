# Fleet load generator

This rig enrolls independent synthetic hosts through the existing operator
enrollment route and sends sealed Tacho sessions to their claimed intake endpoint.
It prepares evidence for #4202. It does not certify fleet capacity.

## Inputs

Copy `profile.example.json` to a reviewed profile. The example contains invented
numbers and `measured: false`, so it cannot send live load. Replace the tenant
UUIDs, slugs, measured session arrival rate, and weighted turn/body-size samples.
Label a baseline from received server events as `sourceKind: received`. That
measurement cannot establish the machine's produced rate or lost local backlog.
Multipliers apply to the one-machine baseline across the whole fleet. At 15,000,
500 hosts each receive 30 times the baseline on average.

The generator supports complete sessions of 1 to 30 turns, each with one model
call and one tool call. A session is one batch. Weighted samples cycle in their
declared order. The report records the generated sample histogram so short phases
cannot be mistaken for the full distribution. Long sessions, overlapping runs
on one host, recorded burst distributions, and dependency faults need additional
workloads. Do not substitute this profile for those acceptance criteria.

Set `FLEET_STAGING_ORIGIN` independently of the profile. It must equal the target
HTTPS origin, whose hostname must have a `staging` label. Every ingest, bundle,
and commands claim must exactly match that origin and the existing route path.
Redirects are refused. Enrollment tenant, device, and host claims are checked.
The initial policy signature must verify with `FLEET_BUNDLE_PUBLIC_KEY_PEM`,
the independently pinned staging public key. Enrollment HMAC verification remains
server-owned; the generator does not copy the deployment's signing secret.
Each control probe also verifies the returned bundle's signature, host, and etag.

`FLEET_OPERATOR_TOKEN` must be a staging org Owner or Admin credential accepted
by the enrollment route. The mandate must retain `model_call` bodies with
`content_exact`. The workload makes no model-provider calls itself. Confirm the
staging background jobs use the intended deterministic responses and have their
own cost limits before live dispatch.

## Commands

Run these on the dedicated CI runner. Local builds and tests remain prohibited.

```sh
pnpm exec tsx tools/scripts/fleet-capacity/run.ts plan reviewed-profile.json
pnpm exec tsx tools/scripts/fleet-capacity/run.ts run reviewed-profile.json
pnpm exec tsx tools/scripts/fleet-capacity/reconcile.ts report.json reconciliation.json
```

Set `FLEET_OUTPUT_ROOT` to an existing absolute directory on the dedicated
runner's persistent disk. The runner account must own it with mode 0700. Live
execution rejects temporary directories, the checkout directory, and symlink
aliases into those locations before enrollment sends any request. Configure the
same value as the staging environment's `FLEET_OUTPUT_ROOT` variable. Choose a
directory outside runner cleanup and retain its disk across runner upgrades.

`plan` sends no requests. Live execution requires `measured: true`, credentials,
and the pinned key. Before dispatch, review the compute, storage, enrichment,
and network estimate against the profile's explicit session, event, body-byte,
request, and network-byte ceilings. Network accounting reserves the full 2 MiB
response bound per request, plus request bytes and 16 KiB of header allowance.
Retries, control requests, replays, and enrollment all consume that budget.
The ceilings stop requests; they do not price cloud services.

The manual `Fleet capacity` workflow defaults to validation and planning. Live
load runs only from `main`, behind the `fleet-capacity-staging` environment, on
a pre-existing `self-hosted, linux, fleet-capacity` runner. Configure environment
reviewers, repository variable `FLEET_STAGING_ORIGIN`, staging environment
credentials, the pinned key, and runner capacity before enabling it. No runner,
store, or cloud resource is provisioned by the workflow.

## Bounds

One disk WAL slot per host holds its next complete session. Queue bytes and
in-flight requests have independent caps. Each persisted batch is retried byte
for byte. Every hundredth successful batch is replayed before its WAL slot is
released. A rejected or unacknowledged batch remains in the private directory.
Scheduled arrivals continue on a fixed clock when queues fill; those arrivals
become missed sessions and events. A large clock jump is counted in bulk.

Enrollment stops after ten minutes. Each request has a body-inclusive deadline.
Arrivals stop at the profile duration or a termination signal, followed by the
bounded drain period. At most 1,600 minute samples and fixed latency histograms
stay in memory. Percentiles are labeled as upper bounds from logarithmic bins.
An abnormal process or runner termination may leave the last minute's report
stale. The WAL remains available for investigation; automatic crash resume is
not implemented.

The private directory contains host credentials and device keys. It is mode
0700, with files mode 0600. The workflow uploads only `report.json`. The persistent directory is the primary
copy. Workflow runs write to `$FLEET_OUTPUT_ROOT/<github-run-id>-<run-uuid>/`.
Manual runs use `$FLEET_OUTPUT_ROOT/<run-uuid>/`. Both contain `report.json` and
a private state directory. Keep these files until reconciliation completes.

GitHub documents a maximum 24-hour lifetime for `GITHUB_TOKEN`, which may limit
self-hosted jobs with longer timeouts. See [workflow timeout limits](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes).
This rig can run longer than 24 hours. Artifact upload is a best-effort copy and
does not control report persistence. Upload authorization after 24 hours has not
been verified for this runner. A cancelled job may leave an unfinished report,
which is not a capacity result.

If upload fails, log in to the same dedicated runner and locate the run directory
under `FLEET_OUTPUT_ROOT` using its GitHub run ID. Read `report.json` there and
run the store reconciler against that file. Copy only numeric reports for review.
Never upload the private directory, which contains credentials and device keys. Revoke the
run's host enrollments through the existing staging fleet controls, then remove
the private directory according to the runner's retention policy.

## Reconciliation

The report compares scheduled, generated, acknowledged, missed, and remaining
events and sessions. It records refusals by HTTP status, retries, control errors,
ingestion latency, arrival-to-ack latency, backlog age, and drain time. Its
`intakePass` concerns intake only. `capacityPass` always remains false.

After background workers drain, run `reconcile.ts` using read-only staging store
credentials. Set `FLEET_CLICKHOUSE_URL`, `FLEET_CLICKHOUSE_HOST`,
`FLEET_CLICKHOUSE_USER`, `FLEET_CLICKHOUSE_PASSWORD`, `FLEET_DATABASE_URL`, and
`FLEET_DATABASE_HOST`. The URL host must equal its independently pinned hostname
and include a `staging` component. The ClickHouse endpoint must use HTTPS.
Postgres reads have one connection, a read-only session, and a 30-second statement
limit. ClickHouse reads cap memory at 128 MiB and execution at 30 seconds.

The reconciler reads `tacho_events FINAL` for the run's independent enrollment
IDs and tenant. It compares persisted event, session, model-call, and body-reference
counts with acknowledged counts. It then checks `cost.run_totals` for the run's
agent keys, including session, model, tool, and token totals and missing prices.
It reports current monetary totals without claiming they prove unchanged charges
after replay. A discrepancy exits nonzero. Re-run after the worker backlog drains
to distinguish delay from loss, retaining each timestamped result.

Body-content integrity, monetary idempotence, tenant isolation, background-job
completion and oldest age, provider admission, service CPU and memory, restart
recovery, and the long-history workload still require independent evidence.
The report lists these as unverified. Follow `docs/runbooks/fleet-capacity.md`
for the full acceptance criteria.

## Offline baseline

`baseline.ts` reads an offline snapshot of one host's Tacho WAL. It reads only
regular files named `<session-uuid>.ndjson`, one file at a time. Synthetic inputs
use the same sealed event format and naming rule. Body sidecars, `cursor.json`,
symlinks, and other files are skipped. The collector never prints event content,
session IDs, host IDs, agent keys, digests, or input paths.

```sh
pnpm exec tsx tools/scripts/fleet-capacity/baseline.ts /snapshot/wal \
  2026-09-08T00:00:00Z 2026-09-09T00:00:00Z baseline.json wal-subset
```

The output contains observed event and session-start rates for the requested
window and its hour/day buckets. Payload statistics describe serialized event
records only; they exclude evidence sidecars and HTTP framing. Complete-session
event counts, turn counts, and durations use sessions wholly inside the window.
Open, truncated, malformed, changing, cross-boundary, and broken-chain files are
counted separately. Quantiles are fixed-bin upper bounds. No list grows with the
number of input events or sessions.

Reads cap each line at 4 MiB, each chunk at 64 KiB, the input at 128 GiB and
100,000 session files, and elapsed time at 30 minutes. The requested window is
at most seven days. Exceeding a resource bound aborts collection without writing
a partial report. The output path must be new. Use a quiescent snapshot; reading
a changing live WAL does not prove a complete producer window.

Choose the coverage label `wal-subset`, `unacknowledged-backlog`,
`operator-attested-complete`, or `synthetic`. The label records your assertion.
The collector does not infer shipping state from retained files and never marks
coverage verified or the rig baseline `measured: true`. A retained WAL subset or
unacknowledged backlog cannot establish the machine's representative produced
rate. An operator assertion alone does not change that.

`rigBaselineDraft` supplies the observed session arrival rate and weighted turn
samples for sessions within the rig's 1-to-30-turn range. It deliberately omits
`bodyBytes`, because the collector did not read evidence content. Complete the
payload distribution from an independent numeric measurement and establish
representative busy-hour/full-day coverage before using a live profile. Request
rate, shipped bytes, acknowledgment status, retries, concurrent sessions, backlog
age, and enrichment work remain listed as missing. The draft is an incomplete
input for review, not a load authorization or a capacity result.
