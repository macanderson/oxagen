# eval.run.start

**Domain:** eval
**Mode:** async
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Start an eval run: enqueue a background job that runs every item in a
dataset through a **target** — either a bare model+prompt or an existing
workspace agent — and scores each output with an LLM judge. Async by
design: the call returns a run handle immediately with `status: "pending"`;
the Inngest worker does the actual work off the request path. Poll
`eval.run.status` for a cheap lifecycle header, or `eval.run.get` once
results are available for full per-item detail.

Both the target call and the judge call are routed through `@oxagen/ai`, so
every token, every millisecond of latency, and the resulting cost land in
the ClickHouse metering pipe exactly like any other AI call in the
platform. This capability is intentionally **not** `noBillingGate` — an org
with zero balance is refused at admission before any item is scored.

## Input

| Field             | Type      | Default  | Notes                                                                        |
| ----------------- | --------- | -------- | ------------------------------------------------------------------------------- |
| `datasetPublicId` | `string`  | required | Public id of the dataset to run against                                        |
| `target`          | `object`  | required | Discriminated union on `kind`: `{ kind: "model", model?, systemPrompt? }` (gateway model slug, optional system prompt prepended to each item) or `{ kind: "agent", agentSlug }` (slug of an agent definition in this workspace) |
| `judgeModel`      | `string?` | precise tier | Gateway model slug for the judge; omitted uses the platform's precise tier |
| `name`            | `string?` | undefined| Optional label for the run                                                    |
| `passThreshold`   | `number`  | `0.7`    | Overall judge score (0–1) at or above which an item passes                    |
| `maxItems`        | `integer?`| all items| Cap on items evaluated this run — cost control (1–500); omitted evaluates every dataset item |

## Output

| Field       | Type          | Notes                                                     |
| ----------- | ------------- | ------------------------------------------------------------ |
| `runId`     | `string`      | Run handle — pass to `eval.run.status` / `eval.run.get`      |
| `status`    | `"pending"`   | Always `"pending"` on start; poll for lifecycle transitions  |
| `itemCount` | `integer`     | Number of dataset items enqueued for this run                |

## Side effects

New run row in Postgres. Inngest jobs queued to run each item through the
target and judge. As the worker executes, target and judge calls are metered
through `@oxagen/ai` into ClickHouse (tokens, latency, cost).

## Errors

None explicitly defined in the contract; admission is refused ahead of the
handler when the org's balance cannot cover the run (billing gate — this
capability is not `noBillingGate`).
