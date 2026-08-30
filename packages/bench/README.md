# @oxagen/bench

Stores Oxagen's own benchmark results in ClickHouse, and reads them back.

This package is private. It is never published, and it is not part of the
product. Nothing a customer runs touches it.

## What it does, and what it does not

The benchmark **harness** — the thing that actually runs SWE-bench and
Terminal-Bench against an agent — is not in this repo. It lives at
<https://github.com/macanderson/agent-arena>. It was removed from this repo in
July 2026 so it could be open-sourced on its own.

This package picks up where that harness stops. The harness writes a results
directory to disk; this package reads that directory, turns it into rows, and
puts the rows in ClickHouse so a run can be looked up later by number.

```
agent-arena run  ->  results dir on disk  ->  @oxagen/bench  ->  bench.* tables
```

Because the two halves live in different repos, nothing here can start a
benchmark. It can only read the output of one that already finished.

## The tables

Three tables, all in a `bench` database of their own — separate from the rest
of the telemetry so it can have its own backup and retention rules. See
`migrations/0001_bench_schema.sql` for the columns and the reasoning.

| Table | One row per |
| --- | --- |
| `bench.benchmark_run` | whole run (one `harbor run` invocation) |
| `bench.benchmark_run_result` | task inside a run — this is what `#2984` means |
| `bench.benchmark_candidate` | best-of-N candidate inside a task |

Runs and task results each get a `public_id`: a plain counter, so a person can
say "replay #2984" instead of quoting a UUID. ClickHouse has no autoincrement,
so ingestion works it out as `max(public_id) + 1`. That is only safe while
ingestion runs one at a time.

## Commands

```sh
pnpm --filter @oxagen/bench migrate            # create/update the bench.* tables
pnpm --filter @oxagen/bench list               # recent task results
pnpm --filter @oxagen/bench list -- --type swe-bench -n 10
pnpm --filter @oxagen/bench replay -- 2984     # show a task and how to re-run it
pnpm --filter @oxagen/bench backfill           # ingest older result dirs
```

Add `--json` to `list` or `replay` for machine-readable output.

`replay` prints a command you can paste into a terminal. Passing `--run` makes
it execute that command instead — but only if you run it from inside an
agent-arena checkout, since that is where the script lives. From this repo,
`--run` will always report that it cannot find the script.

## Storage rules

All ClickHouse access goes through `chBenchInsert` / `chBenchQuery` /
`chBenchCommand` in `@oxagen/telemetry/bench-client`. This package must never
import the raw `clickhouse()` client. Benchmark data has no org or workspace,
so those wrappers deliberately skip the tenant-scoping every other query gets.

## The one rule about secrets

The `config` column is meant to be readable by anyone with access to the
`bench` database. It records env var **names**, never their values:

```json
{ "apiKeyEnv": "AI_GATEWAY_API_KEY" }
```

`assertNoSecretValues` (`src/secrets.ts`) checks this before every insert and
throws if a secret-looking key holds something that is not a plain env var
name. It catches the obvious mistake, not every mistake — a value that happens
to look like an env var name still gets through — so the real guarantee is
care at the call site.
