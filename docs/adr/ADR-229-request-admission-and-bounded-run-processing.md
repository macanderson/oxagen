# ADR-229: Request admission and bounded run processing

- **Status:** Accepted
- **Date:** 2026-09-30
- **Owners:** API, MCP, billing, run evidence
- **Related:** #4202, #3784, ADR-150

## Context

Production API and MCP processes exhaust their JavaScript heaps while containers
remain below their resident memory limits. Both services had 512 MiB containers.
Node selected a heap limit of about 259 MiB. Retried work starts again after each
crash. Price history, run history, simultaneous uploads, and request parsing can
all increase the amount of live data.

The capacity target is 500 machines, each producing 30 times Mac's measured
workload, at the same time. That is 15,000 times the baseline arrival rate. A test
that refuses 15,000 requests proves neither that rate nor timely processing.

## Decision

1. Admit API and MCP requests before reading bodies or authenticating them.
   Bound each work class and reserve memory across all classes in the process.
   Reject excess work with HTTP 503 and `Retry-After: 2`. Keep rejected work out
   of application waiting queues. Existing durable senders retain responsibility
   for unacknowledged events.
2. Keep each reservation through the response lifetime and tracked asynchronous
   work. A disconnected socket does not mean its tool or kernel call stopped.
   Release once all tracked work finishes. Expose active reservations in metrics.
3. Count body bytes before parsing. Default HTTP JSON bodies have a 4 MiB limit.
   API attachment uploads keep their existing larger encoded-body allowance.
   Reject compressed MCP request bodies. Keep health probes outside admission.
4. Stream cost frames and ledger rows in batches of 256. Resolve each model batch
   against a filtered price book in one repeatable-read snapshot. Bound price
   rows and aggregate cardinality. A limit or query failure aborts before totals
   are replaced. Keep whole-run rounding and repeat detection across batches.
5. Bound database work as well as application arrays. Cost queries carry time
   limits. PostgreSQL cursor transactions bound sort memory and idle time.
   ClickHouse cost queries bound memory, thread count, and spill thresholds.
6. Share evidence-write admission by storage adapter. Retain at most 64 unique
   writes and 64 MiB of admitted plaintext. Coalesce duplicate writes. Verify a
   remembered completed object still exists before skipping its rewrite.
7. Negotiate blob access once. Bound callers waiting for that result. Reuse the
   body across the refused private attempt and the public retry. Remote asset
   and OAuth avatar downloads count streamed bytes against their kind limit.
   Their ten-second deadline covers redirects, headers, and body transfer.
8. Read enrichment bodies and scratch objects within explicit byte limits.
   Write transcript chunks as they are produced. Keep the text, body count,
   prompt, and summary-call ceilings. State when an account covers only a prefix.
9. Limit background functions globally in addition to their existing per-run
   serialization. Inngest holds pending jobs durably instead of the API holding
   more concurrent executions.
10. Set explicit container and heap limits. API receives 1,536 MiB with a
    1,024 MiB old-space limit. MCP receives 1,024 MiB with a 640 MiB old-space
    limit. Generic MCP tools reserve 256 MiB because a video asset can download
    100 MiB before storage. These are initial operating budgets, not a fleet
    capacity claim.
11. Emit process memory, reservations, admissions, and rejections every 30 seconds.
    Alarm on the V8 diagnostic itself. V8 aborts do not set Docker's OOMKilled
    flag. Alarm separately on sustained projected memory pressure.
12. Check the whole node before replacing a service. Sum hard container limits,
    include a 256 MiB limit for Caddy, and reserve 1 GiB for host services. Swap
    does not count as physical capacity. Refuse unknown unlimited containers or
    insufficient RAM before stopping the current service. Hold one node-wide
    deployment lock through replacement, health checks, and rollback.
13. Read conversation exports in one database snapshot with a 500-message and
    2 MiB content-and-metadata ceiling. Refuse oversized exports before loading
    their payload into Node. Bound PDF text, blocks, and pages before storage;
    report the limit without publishing a partial export.

## Consequences

Busy services may answer 503 sooner. An overloaded service must preserve evidence
and accounting correctness rather than acknowledge data it has not committed.
Operators must track retry rate and backlog age alongside memory. Flat memory
with an ever-growing backlog is a failed capacity result.

Memory reservations are conservative estimates of transient allocations. They
cannot prove a byte ceiling for every capability. New bulk paths must add bounded
reads and writes and constrained-memory regression coverage. A stuck operation
holds its slot until it terminates. Health readiness does not automatically
restart a process just because all slots are temporarily occupied.

The current shared application node and process-local MCP relay state are not a
validated 500-machine topology. Increasing replica count without routing each
relay session to its owner would break delivery. Separate API intake, MCP relay
ownership, and background processing before approving that topology. Size their
stores using measured arrival rate, payload distribution, and service time.

## Verification

CI runs admission lifecycle tests, a constrained-heap subprocess with repeated
500-offer bursts, storage capacity tests, bounded enrichment tests, and real
PostgreSQL and ClickHouse batch-boundary regressions. None run on Mac's laptop.

After deployment, record the deployed SHA and observe API and MCP for 24 hours
without heap exhaustion. Keep #4202 open until its deployment and observation
criteria pass. The fleet acceptance procedure is in
[the capacity runbook](../runbooks/fleet-capacity.md).
