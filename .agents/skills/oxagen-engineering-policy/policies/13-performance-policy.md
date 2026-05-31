# Performance Policy

Cost is a feature. Every line of code spends money, in compute and in dollars, on every run at scale. Write as if you are paying the bill, because the company is. This policy is binding: an agent evaluates every line it writes for an optimization opportunity before committing it, and defaults to the cheapest correct approach.

## Mindset

- Treat compute and spend as first-class constraints, equal to correctness. A working feature that wastes resources is not done.
- Before writing any line, ask: does this need to run at all, run now, run here, or run this many times? The cheapest work is the work you skip.
- Optimize for the common path and the steady state, not the demo. Cost shows up at volume, so reason about the hundred-thousandth call, not the first.
- Measure, do not guess. Claims of "faster" or "cheaper" are backed by a number. Instrument hot paths through the shared analytics package so cost and latency are observable, not assumed.
- Cheapest correct wins. Never trade correctness or the non-negotiables for speed, and never add complexity for a micro-optimization that does not move a real number (this stays subordinate to the simplification policy).

## Deferred Loading

- Load modules, tools, models, clients, and heavy resources lazily. Nothing expensive is imported or initialized at startup unless every run needs it immediately.
- Tools and skills are loaded on demand at the point of use, not eagerly registered with their full payload. Auto-discovery (see file organization policy) registers lightweight descriptors; the heavy implementation loads only when actually invoked.
- Defer expensive imports to inside the function that needs them when that import is rare or costly, rather than paying the import cost on every cold start of the whole process.
- Connections, model clients, and pools are created lazily and reused, never re-created per call. Initialize once on first need, then share.
- Do not load data you might use. Load the data the current operation provably needs, when it needs it.

## Async and Concurrency

- I/O-bound work is async by default. Network calls, database queries, model calls, and file I/O never block a thread that could be doing other work.
- Independent operations run concurrently, not in sequence. If two calls do not depend on each other, issue them together (`asyncio.gather` and equivalents), never one-after-another.
- CPU-bound work is parallelized across cores where it pays for itself: worker processes, thread pools for releasing the GIL via native extensions, or offloading to the worker service. Do not serialize work that could fan out.
- Long-running and schedulable work goes to the async worker tier (Celery), off the request path. The API stays thin and fast; expensive work is queued, not awaited inline.
- Bound concurrency deliberately. Unbounded fan-out is its own cost and failure mode; use semaphores, pool limits, and backpressure so concurrency helps rather than overwhelms.

## Batching

- Batch external calls. Model calls, database writes, and third-party API requests are grouped wherever the API supports it, turning N round trips into one.
- Never loop a single-row query or a single-item API call when a set-based or bulk operation exists. One query for many rows beats many queries for one row each.
- Prefer set-based SQL over row-by-row processing. Push the work into the database engine instead of pulling rows into application loops.
- Coalesce and debounce high-frequency events before they hit an expensive sink. Aggregate telemetry and writes rather than emitting one expensive operation per event.
- Right-size batches. Tune batch size to the sweet spot between round-trip savings and memory or latency cost; do not load an unbounded set into memory in the name of batching.

## Model and Token Cost

- Token spend is real money. Send the smallest prompt that does the job: trim context, summarize history, and retrieve only the relevant nodes rather than dumping the graph.
- Match the model to the task. Do not reach for the most expensive model when a cheaper one meets the bar. Reserve the heavyweight model for work that genuinely needs it.
- Cache model results that are deterministic or stable for an input, and reuse them instead of paying for the same completion twice.
- Stream and stop early where possible; do not generate tokens past the point the answer is complete.

## Data Access and Caching

- Caching is a primary tool, not an afterthought. Cache the expensive and stable: computed results, hot reads, and idempotent lookups, with explicit keys and explicit invalidation.
- Avoid N+1 access patterns everywhere, in SQL and in graph queries alike. Fetch related data in one traversal or one joined query.
- Select only the columns and properties you use. Do not `SELECT *` or pull whole nodes when a projection suffices.
- Paginate and stream large result sets. Never materialize an unbounded collection in memory.

## Review Gate

Before any code merges, the author confirms:

1. No expensive resource loads eagerly that a deferred load would avoid.
2. Independent I/O runs concurrently; nothing blocks that could be awaited or batched.
3. No N+1 patterns and no single-item loops where a bulk or set-based operation exists.
4. Prompts and model choices are sized to the task, not the maximum.
5. Hot paths are instrumented so their cost is observable.
6. Any optimization added actually moves a measured number and does not violate the simplification policy.
