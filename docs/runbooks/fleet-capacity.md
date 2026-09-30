# Fleet capacity

The acceptance target is 500 concurrently active machines, each producing 30
times the measured baseline from Mac's machine. Validate successful processing
at that rate. Request rejection and stable memory alone do not pass.

## Baseline

Measure at least one representative busy hour and one full day. Record event
count, serialized bytes, requests, concurrent sessions, tool calls, run lengths,
and enrichment work per second. Record p50, p95, p99, and maximum payload sizes.
Keep only numeric distributions and synthetic fixtures in CI artifacts. Do not
copy recorded prompts, evidence bodies, credentials, or customer identifiers.

Multiply the measured rates by 15,000. Preserve payload and session-length
distributions. Model 500 independent host identities. Increasing a single
identity's rate does not exercise tenant isolation, per-host limits, connections,
or store key cardinality.

## Environment

Use isolated stores, credentials, blobs, and Inngest in the staging environment
from ADR-150. Do not send the fleet workload to production. Record the SHA,
container limits, Node heap limits, replica counts, database limits, and worker
concurrency with every result. Estimate the run's compute, storage, model, and
network cost before provisioning additional capacity.

The node deployment preflight counts every running container's hard limit and
reserves 1 GiB for the operating system, Docker, and monitoring. It rejects
unlimited containers and ignores swap when calculating capacity. With the API,
MCP, Caddy, and existing service budgets, the node needs at least 9,984 MiB of
physical RAM. A node resize supplies headroom; it does not prove fleet throughput.

Separate intake from background workers before scaling them independently.
Keep MCP relay sessions routed to their owning process, or implement a shared
broker with durable ownership and reconnect recovery. The current process-local
brokers do not support arbitrary round-robin routing across replicas.

## Workload

Run these phases against real intake, evidence persistence, pricing, and
enrichment. Use synthetic evidence and deterministic model responses for repeatable
capacity measurements. Measure real model-provider admission separately.

1. Ramp through 1, 30, 300, 3,000, and 15,000 times the baseline arrival rate.
2. Hold the target rate for 24 hours with all 500 identities active.
3. Replay the measured burst distribution and a simultaneous reconnect.
4. Delay storage responses, fail selected requests, and restart a worker while
   requests are active. Restore the dependency and measure backlog recovery.
5. Retry acknowledged and unacknowledged batches. Verify idempotence, sequence
   continuity, body digests, tenant isolation, and unchanged monetary totals.
6. Exercise long histories and cardinalities at their documented limits. A
   refused rollup must retain its previous totals and record its failure.
7. Stop arrivals and wait for the backlog to drain. Compare settled heap, native
   memory, and resident memory with the warmed-up baseline.

Bound the load generator's own queue. Count scheduled arrivals that it cannot
send as missed load. Do not slow the arrival clock to match server throughput.

## Runner

The [fleet runner](../../tools/scripts/fleet-capacity/README.md) and the
`Fleet capacity` workflow provide a staging-only starting point. The default
workflow validates an illustrative profile and sends no network load. Live
execution requires measured inputs, pinned staging endpoints and keys, a
dedicated runner, and explicit request and byte ceilings.

The runner records scheduled, generated, missed, acknowledged, retried, and
pending work. Its separate store reconciler compares acknowledged work with
persisted events and derived token counts. Its report keeps `capacityPass` false
until the remaining acceptance evidence is supplied independently. Do not use
the illustrative profile as Mac's measured baseline.

## Acceptance

Require zero lost acknowledged events, zero duplicate charges, and zero heap or
container OOMs. Require processed throughput to match target arrivals throughout
the sustained phase, with bounded backlog age and no upward backlog trend.
Record p95 and p99 ingestion acknowledgment and control-request latency. Choose
and record their service-level thresholds before starting the run.

Report 503s, retries, missed generator arrivals, completed jobs, oldest pending
job age, and post-failure drain time. An omitted metric is an unverified criterion.
Record per-service CPU, RSS, heap, native allocations, event-loop delay, store
latency, database memory, and connection counts. Retain the full CI result and
production observation window on #4202.

The constrained-heap admission regression covers 15,000 offers with most refused.
It is an overload-safety regression. It does not satisfy this acceptance test.
