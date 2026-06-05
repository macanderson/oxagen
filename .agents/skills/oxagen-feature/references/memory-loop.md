# Code graph + memory loop (Oxagen plugin)

The Oxagen plugin to Claude Code lets a worker query the typed code graph and write memories back onto graph nodes. This is the loop that makes Oxagen self-improving, so treat it as core workflow, not tooling trivia.

## Query first, always

Before writing or changing code, query the graph to answer:
- Does this capability or utility already exist? (If yes, import the shared package; do not reimplement.)
- Which nodes does my change touch, and what depends on them?
- Are there existing memories on those nodes warning of constraints or past bugs?

Querying is unconditional and cheap. Skipping it is how copy-paste and N+1s creep in.

## Write a memory against every changed node, weighted

Memory serves two needs that pull apart: **auditability** (a complete append-only record, also usable as checkpointing) and **retrieval signal** (the lessons a future agent should see). Weight reconciles them. Always log; let weight decide what surfaces.

**Always write a memory** keyed to the node you touched. Nothing is skipped, so the audit trail and checkpoint history stay complete.

**Assign a weight by event kind** (no scoring math, just the bucket the kind implies):
- `low` — routine, self-evident change. Logged for audit, below the default retrieval threshold.
- `high` — non-obvious lesson: discovered constraint, root cause invisible from the code, deliberate convention deviation, node-specific gotcha.
- `critical` — production incident or bug-root-cause, once exception watchers and bug reports exist.

Default retrieval reads `high` and up. Audit and checkpointing read everything. This keeps the well clean without throwing anything away.

### Why buckets, not a model, for now

Oxagen is building Oxagen, so there is no production signal to calibrate a weighting function against. A hand-tuned model today is guesswork you will discard once real retrieval and real incidents show what matters. The coarse buckets capture the one judgment you can actually make now — routine versus lesson versus incident — and leave numeric weighting for when production earns it.

## Memory structure

```json
{
  "nodeRef": "<code-graph node id or path the memory attaches to>",
  "weight": "low | high | critical",
  "kind": "routine-change | constraint | bug-root-cause | convention-deviation | gotcha",
  "lesson": "One or two active-voice sentences. For low-weight, a terse record of what changed.",
  "source": "feature | fix | exception-watcher | bug-report"
}
```

Write it through the plugin so it lands on the node, not in a loose file. The `source` field anticipates the future: today it is `feature` or `fix`, later the same store absorbs `exception-watcher` and `bug-report` memories, and the retrieval contract stays identical.

## Why this compounds

A memory keyed to a node means the next agent that queries that node inherits the lesson before it makes a change. When exception watchers and customer bug reports come online, they write memories in the same shape onto the same nodes, so a single query surfaces both "what we learned building this" and "what has gone wrong in production here." That shared retrieval contract is the point.
