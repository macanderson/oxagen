# agent.compose

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Plan and execute a chain of capabilities to accomplish a goal. An LLM planner
reads the agent-surface capability catalog — enriched with the
`produces`/`consumes`/`chainHints` metadata from `capability-meta.ts` — together
with the workspace system prompt (`prompt.settings.read`) and the workspace's
enabled skills (`skill.workspace.list`), then drafts an ordered plan. The
executor threads each step's **output** into dependent steps' **inputs** via
`$steps.<id>.<dotpath>` bindings, runs every step through the same `invoke()`
kernel path (so IAM / billing / entitlement gates all apply), and finally
synthesizes a natural-language summary for the user.

Destructive or approval-required capabilities are **planned but never
auto-executed** — they come back as `skipped` so a human stays in the loop.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| goal | string | What to accomplish (1–2000 chars) |
| maxSteps | number | Maximum number of steps the planner may produce: 1–10 (default: 6) |
| autoExecute | boolean | When false, returns the plan WITHOUT executing it — a dry run (default: true) |
| context | string? | Extra context or constraints for the planner (optional, ≤4000 chars) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| goal | string | Echo of the requested goal |
| plan | array of objects | The ordered plan (id, capability, rationale, inputJson, dependsOn) |
| steps | array of objects | Per-step execution result (status, resolved input, output/error, durationMs) |
| summary | string | Natural-language synthesis of what was accomplished or proposed |
| executed | boolean | Whether the steps were executed (false for a dry run) |

Each plan object:
- id: string (e.g. "step1")
- capability: string (capability name to invoke)
- rationale: string
- inputJson: string (JSON input; may contain `$steps.<id>.<dotpath>` bindings)
- dependsOn: string[] (step ids that must complete first)

Each step result object:
- id: string
- capability: string
- rationale: string
- status: "success" | "error" | "skipped"
- input: object | null (the resolved input actually invoked)
- output?: unknown (present on success)
- error?: string (failure / skip reason)
- durationMs: number

## Side effects

- Calls the LLM twice (plan + summary) through `@oxagen/ai`, metered to the org.
- Executes each safe planned step through `invoke()`, which may have its own
  side effects (graph writes, web searches, etc.) and is independently metered
  and IAM/entitlement gated.

## Chaining

`agent.compose` is the composition primitive of the capability engine. It reads
the chain metadata (`produces`/`consumes`/`chainHints`) declared on every
contract to discover valid output→input chains, and renders its result through
the `capability-chain-card` chat component (per-step status + expandable
input/output). Typical follow-on: `documents.generate` to turn the summary into
a downloadable report.
