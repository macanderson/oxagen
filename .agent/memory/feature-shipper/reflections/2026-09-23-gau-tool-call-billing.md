## Self-Evaluation — bill wrapped-harness and external MCP tool calls as GAU — 2026-09-23

### What I set out to do
Bill one governed action unit per allowed tool call in a wrapped harness
(Tacho ingest) and per completed external MCP call in the agent runtime, on
the ADR-158 ledger, with retries deduplicated. Pass the model's tool-call id
through to `invoke()` for capability tools.

### What I actually did (measurable deltas)
- `isBillableToolCall` + `tachoToolCallEntries` in
  `packages/handlers/src/tacho.events.ingest.ts`: hook-sourced `tool_call`,
  `tool_status: ok`, not Oxagen's own MCP server. Key
  `tacho:<session_uuid>:<tool_use_id>`, fallback `event:<event_id_idem>`.
- Billing runs after the ClickHouse append and the seal dispatch, and throws
  on failure. The control-envelope drain moved out of the ingest transaction
  to the end, so a post-commit failure (billing or ClickHouse) no longer
  loses commands marked `sent`. That was a pre-existing defect for the
  ClickHouse path.
- External MCP: `assertGauAvailable` after IAM, before rules and consent;
  `recordExternalToolCall` after a successful transport; never throws.
- Capability tools: `{ ...ctx, toolCallId }` when the options carry an id.
- Tests: ingest file 89 → 100 cases (all pass), materialize-tools 87 → 96
  (all pass). One mutation check (agents predicate) confirmed the new
  `agentLookups` pin catches a wrong column.

### Quality of my decisions
- Best: building ledger entries from every event in the batch, not `fresh`.
  A billing failure followed by a re-send would otherwise bill nothing,
  because the re-sent events sit below the recorded head.
- Weakest: failing the request on a billing error. It is durable for
  transient faults, but a permanent billing defect stalls the host's WAL
  (the spool retries 5xx forever). I narrowed the surface (non-null
  `toolName`, validated workspace uuid) but did not bound the retries.

### What I could have done better
1. Checked earlier whether `@oxagen/billing`'s index has load-time `schema`
   reads. The materialize-tools test's `importOriginal` failed on
   `statement-reads.ts:101`, and I spent a round finding a narrower import.
2. Proposed a reconciliation sweep (re-derive tacho entries from
   `tacho_events` and offer them to the ledger) as the backstop for the
   permanent-failure case, instead of only naming the risk.
3. Written the child-session test against a fake that keys `update` on the
   real session uuid; the shared fake hard-codes `SESSION`, so the child's
   counter increments land on the root row in that test.

### What surprised me about this codebase/product
- Tacho's MCP gateway frames are `collector`-sourced, and a harness calling
  `mcp__oxagen__*` is billed by the kernel, so double-billing hides in the
  source field and the server name.
- The control envelope was drained inside the ingest transaction, so every
  post-commit failure already lost commands.

### Risks I am leaving behind (untouched on purpose, and why)
- A permanent billing failure stalls ingestion for the org's hosts. Needs a
  maintainer decision between bounded retries and a reconciliation job.
- `tool_status: error` bills nothing. This matches the kernel and external
  rule. A one-line change flips it if the maintainer wants failed calls billed.
- A Bash call that runs the `oxagen` CLI bills once in Tacho and once in the
  kernel. They are two distinct actions, but a customer may read them as one.

### Confidence in the result: medium
Both changed test files pass in isolation. No typecheck, lint, or suite was
run, per the shared-machine rule. CI must confirm types (the `tx.query.agents`
relational read and the `ExecuteCallOptions` parameter on `tool()`).
