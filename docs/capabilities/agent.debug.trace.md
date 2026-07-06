# agent.debug.trace

**Domain:** agent
**Mode:** sync
**Scope:** tenant (org + workspace)
**Requires approval:** no
**Risk level:** low
**Aliases:** `debug_with_trace` (agent-surface tool name)

## Intent

Diagnose **why one agent execution failed** and return a small, typed
**failure frame** instead of a wall of raw logs. This is the structured-tool
half of [ADR-021](../adr/ADR-021-inference-doctrine.md) §3: raw output never
enters a model's context — every field here is produced by a deterministic
compressor (parse, rank, truncate) over three bounded sources, so the frame is
safe to feed straight to a model.

Prefer `agent.debug.trace` over reading raw logs or the full
[`agent.trace.get`](agent.trace.get.md) tree when an execution has **failed** and
you need the fix site. Use `agent.trace.get` for a successful run's full tree and
[`agent.execution.list`](agent.execution.list.md) to find runs.

## How it composes (deterministic-first)

1. **Postgres span tree** — reuses `agent.trace.get` for the related spans and
   the failing step (Postgres is the source of truth for the execution tree).
2. **ClickHouse `error_events`** — every error captured for the execution, joined
   by `execution_id` (added in telemetry migration `0022`; before that the table
   only carried the often-empty OTEL `trace_id`).
3. **ClickHouse `execution_logs`** — a bounded tail of `warn`/`error`/`fatal`
   log lines.
4. **Tool-call arguments** — file paths passed to the failing execution's tools,
   mined for the suspect-file ranking.

`suspectFiles` are ranked by a **pure function** (stack-frame files weighted
highest, then tool-arg and failure-reason mentions) — **no model call**. The
optional `diagnosis` is the only model-produced field and runs **only** when
`summarize: true` (ADR-021 §1 determinism ladder).

## Input

| Field         | Type      | Default | Notes                                                                 |
| ------------- | --------- | ------- | --------------------------------------------------------------------- |
| `executionId` | `string`  | —       | Public ID (`aex_…`) or UUID of the failed execution.                  |
| `depth`       | `number?` | full    | Max child-execution depth included in related spans (1–10).           |
| `summarize`   | `boolean?`| `false` | When `true`, also run **one** model call to produce a `diagnosis`.    |

## Output — the failure frame

| Field          | Type                    | Notes                                                                 |
| -------------- | ----------------------- | --------------------------------------------------------------------- |
| `executionId`  | `string`                | Resolved `aex_*` public ID.                                           |
| `status`       | `string`                | Root execution status.                                                |
| `failingStep`  | `FailingStep \| null`   | Deepest failed step; `toolName`/`toolCallId` set when a tool failed.  |
| `errorClass`   | `string \| null`        | From the captured error, else parsed from the failure reason.         |
| `message`      | `string \| null`        | Bounded error message.                                                |
| `topFrames`    | `StackFrame[]`          | Parsed top stack frames (function, file, line, column, `internal`).   |
| `relatedSpans` | `RelatedSpan[]`         | Flattened subtree, failed-first, bounded (≤ 40).                      |
| `suspectFiles` | `SuspectFile[]`         | `{ path, score, reasons[] }`, ranked deterministically (≤ 10).        |
| `errorEvents`  | `ErrorEventSummary[]`   | Bounded sample of captured errors (≤ 15).                             |
| `logsSample`   | `LogLine[]`             | Bounded tail of warn/error/fatal logs (≤ 25).                         |
| `diagnosis`    | `Diagnosis \| null`     | LLM root-cause diagnosis — only when `summarize: true`, else `null`.  |
| `truncated`    | object of booleans      | Which lists the compressor clipped to their caps.                     |

`Diagnosis` mirrors the artifact in `@oxagen/agent-engine`:
`{ problem, expectedBehavior, rootCauseHypotheses[{id, statement, evidence}],
blastRadius[], diffBudget }`.

## Bounds

Every list is capped before it reaches the caller (frames ≤ 12, spans ≤ 40,
suspect files ≤ 10, logs ≤ 25, errors ≤ 15); the ClickHouse reads are
`LIMIT`- and time-window-bounded; the tool-call scan for suspect files is capped
at 200 calls. `truncated` flags where a cap was hit.

## Surfaces

`agent` (as `debug_with_trace`), `api` (`GET /v1/{org}/agent/debug/trace/:executionId?summarize=&depth=`),
`mcp` (`agent.debug.trace`).
