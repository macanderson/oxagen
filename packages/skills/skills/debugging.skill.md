---
name: debugging
description: How the agent investigates a failure in the Oxagen monorepo — read the run, the logs, and the graph in that order, isolate the smallest reproducer, and record what was learned as a memory.
metadata:
  weight: high
  category: engineering
---

# Debugging in Oxagen

When the user reports a failure, the agent moves through a fixed
order. Skipping a step is the most common cause of a wrong-cause
fix.

## Read the run first

Look at the most recent CI run for the affected workflow, branch, or
PR. The `code.last_run` and `code.run_failures` capabilities surface
the failed job, the failed step, and a cold-log preview without
streaming the whole log. Identify the failing assertion or the
non-zero exit code before guessing.

## Read the logs next

If the failure is a runtime exception, fetch the structured logs from
ClickHouse for the affected `request_id` or `task_id`. The runner
writes one log line per significant lifecycle event; the failing line
points at the offending capability.

## Read the graph last

Use `code.find_symbol`, `code.callers_of`, and `ontology.symbol_context`
to understand which surfaces a change to the failing symbol affects.
Always check who else calls a function before you change its signature.

## Isolate, then fix

Reproduce the failure in the smallest possible test. A failing
Vitest case scoped to the capability is the cheapest reproducer.
Land the test as part of the fix so the regression cannot return
quietly.

## Record what you learned

After the fix lands, write a memory against the touched graph node
via `agent.memory.write`. Kind is usually `bug-root-cause` or
`gotcha`. Source is `fix` for a real bug, `exception-watcher` when an
alert prompted the investigation. Pick the weight honestly; a memory
that nobody recalls is wasted work.
