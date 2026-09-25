# ADR-181: ClickHouse on the app node keeps two system logs

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** platform
- **Related:** issue #4243 (run reads refused at the memory cap), issue #1305
  (metric logging held the old data node at its CPU ceiling), ADR-042 (the
  data plane).

## Context

ClickHouse runs in a 2 GiB container on the app node with
`max_server_memory_usage` at 1.5 GiB. At idle it tracked 830 MiB, which left
about 600 MiB for every query on the node. When heavy transcript reads ran,
small `get_run` frame reads failed with code 241 (`Memory limit (total)
exceeded`), and the Run page and the in-app assistant lost the run (#4243).

The bootstrap already removed `metric_log`, `asynchronous_metric_log`,
`text_log`, and `trace_log` (#1305). Eleven other system logs were still on.
`processors_profile_log` held 17.8M rows after eight days, `part_log` 642k,
and `error_log` 1.1M. No Oxagen code reads any of them. The one reader of any
system table is a benchmark test that reads `system.query_log`.

The choice was between raising the container's memory and cutting what
ClickHouse holds at idle. On 2026-09-25 Mac chose to turn the system logs off.

## Decision

Every ClickHouse system log on the app node is off except two:

- `query_log` stays, with a seven-day TTL. It is how a refused read is
  diagnosed: #4243's cause came from it, and #4243's definition of done is
  verified against it.
- `crash_log` stays. It writes only when the server crashes.

`infra/modules/app-node/user-data.sh.tftpl` writes the list into
`zz-oxagen-limits.xml`, the one config override the container mounts.

## Consequences

- Idle memory fell from 830 MiB to 270 MiB when the change was applied to the
  production node on 2026-09-25. The memory cap and the container size are
  unchanged.
- A per-processor profile, a part history, and an error-count history are no
  longer recorded. Turning one back on is a config edit and a restart.
- Changing the bootstrap replaces the node when `infra.yml` applies it, on
  both the production and the staging stack. The production node carried the
  change by hand before the merge, so its replacement rebuilds a node that
  already runs this config.
- Adding a TTL to an existing system log makes ClickHouse rename the old
  table to `<name>_0` and create a new one. Drop the renamed table. Do not
  alter its TTL: that rewrites every part, and on this node the rewrite held
  memory at the 1.5 GiB cap until it was killed.
