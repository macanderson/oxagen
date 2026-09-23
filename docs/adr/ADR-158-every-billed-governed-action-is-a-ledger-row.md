# ADR-158: Every billed governed action is a ledger row, wrapped tool calls bill, and statements and prepaid orders read from the ledger

Status: Accepted
Date: 2026-09-23
Owners: platform
Refines: ADR-052 (the governed action is the billable unit), ADR-055 (monthly GAU buckets and contracted rates), ADR-053 (the in-app assistant's usage credits)
Related: ADR-043, ADR-101, [docs/specs/governed-action-metering.md](../specs/governed-action-metering.md)

## Context

An enterprise customer reads an Oxagen invoice beside the record of what their agents did. Finance asks which team spent the month's allowance. Security asks which agent made the calls. The operator who started a run asks what it cost. Before this decision the record could not answer any of them.

The meter counted and kept nothing else. The kernel built a `GovernedActionRecord` with the workspace, the principal, the operator, the surface and the request. The billing bootstrap passed four of those fields to the recorder, which incremented `billing.gau_buckets.used_gau` and wrote the rest to a log line. An invoice line was a quantity and a rate with no rows behind it.

Three further gaps sat under that one.

1. **Retries billed twice.** ADR-052 excludes "a retry within one attempt" from billing, and nothing implemented it. The recorder had no idempotency key, so a tool call the engine re-executed was two governed actions.
2. **Wrapped harnesses billed nothing.** A tool call made by Claude Code, Codex, Cursor or Stella is decided on the host from the Tacho policy bundle and reaches Oxagen through `ingest_tacho_events`, which is `noBillingGate: true`. External MCP tools the in-app agent calls through `authorizeExternalCapability` never pass through `invoke()` either. The governed activity customers buy Oxagen for produced no governed action units.
3. **Statements existed only for model spend, one month at a time,** and enterprise customers had no way to pay in advance by invoice for a licence and for the in-app assistant's usage credits.

## Decision

### 1. The ledger is the itemisation of the bucket

`billing.gau_ledger` holds one row per billed governed action. `debitWithLedger` (`packages/billing/src/gau-ledger.ts`) writes the rows and adds their units to the month bucket in one transaction:

1. `ensureCurrentBucket` with zero deltas creates or locks the month's row.
2. The rows insert `ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING units`.
3. `used_gau` increases by exactly the units that inserted.

The bucket stays the balance the admission gate reads. The ledger is the record behind it. Because the two writes commit together, the units a bucket received from the ledger equal the sum of that bucket's rows, and a statement can be reconciled to an invoice line by adding rows.

Each row records the source, the capability or the tool, the MCP server, the surface, the harness, the workspace, the agent, the principal, the operator, the run, the session, the tool call, the request, the units, when the action happened (`occurred_at`) and when it was billed (`billed_at`). A field the source did not know is null. None is invented, because a fabricated agent or run id would attribute a charge to something that did not incur it.

The workspace column is `attributed_workspace_id`, not `workspace_id`. The ledger is an organisation-wide money record in the `org_only` RLS class. A `workspace_id` column would make it a workspace-scoped table whose rows the organisation's own billing reads could not see.

Statements select on `billed_at`, not `occurred_at`. A Tacho batch recorded on the 1st for tool calls made on the 31st debits the new month's bucket. Selecting on `billed_at` puts those rows on the same month's statement as the invoice that charged them.

### 2. The idempotency key names the logical action

A retry bills once when its key matches the first attempt's. The key comes from whatever names the action rather than the attempt:

| Source | Key |
|---|---|
| Kernel invoke answering an agent tool call | `kernel:tool:<run or turn>:<tool-call id>` |
| Kernel lifecycle execution | `kernel:lifecycle:<capability>:<lifecycle idempotency key>` |
| Any other kernel invoke | `kernel:inv:<uuid>`, unique per invocation |
| Wrapped-harness tool call | `tacho:<session uuid>:<tool-use id>` |
| External MCP tool call | `external_tool:<run or turn>:<tool-call id>` |

A kernel invoke with no stable name for its logical action gets a key of its own. That preserves the pre-ledger behaviour, and it errs in the safe direction: a shared key would silently drop a second, distinct action. An API client that retries without an idempotency key is still billed per request. Accepting a client-supplied key on the API is a separate change.

`CapabilityContext.toolCallId` carries the model's tool-call id from `materializeTools` into the kernel for exactly this purpose. It is never an identity.

### 3. A tool call in a wrapped harness is one governed action

The maintainer decided on 2026-09-23 that each tool call a wrapped harness makes and Tacho allows costs one governed action unit. Denials stay free, as ADR-052 requires. `ingest_tacho_events` records the units for the allowed tool calls in each batch, keyed on the session and the harness's tool-use id, so a batch the host re-sends bills nothing new.

A frame bills when it is a `tool_call` sealed by the hook with `tool_status = ok`, for a server other than Oxagen's own MCP server (`isBillableToolCall`, `packages/handlers/src/tacho.events.ingest.ts`):

- **The hook, not the OTel or transcript repeats.** The hook is where Tacho rules on the call. The repeats observed it.
- **Completed, not rejected, cancelled or errored.** The same rule the kernel applies to a handler that throws.
- **Not Oxagen's own MCP server.** That call runs `invoke()`, and the kernel already bills it.

Denials never reach the post-tool hook. They seal a `policy_decision` or `token_denied` frame, so they are free by construction. A shell call that runs the `oxagen` CLI is two actions and bills twice: the tool call Tacho allowed and the capability the kernel ran.

The ledger entries are built from every event in a batch, not only the frames past the recorded head, so a batch re-sent after a failure still bills the calls it carries. A billing failure fails the ingest request. The host keeps the batch until a 2xx and re-sends it, and the ledger deduplicates it. To make that safe, the control commands a response delivers are now drained after billing, in a transaction of their own, so a refused batch leaves them queued.

The contract stays `noBillingGate: true`. The admission gate never refuses a recording, because refusing to record a run is refusing the evidence Oxagen exists to keep. A prepaid organisation that runs out through recorded tool calls is topped up from its saved card by the same step the kernel recorder runs. Otherwise its next server-side governed action is refused, and the host's cached policy bundle keeps deciding locally.

External MCP tool calls that Oxagen authorises for an agent bill the same way. They run the GAU admission gate before the call, and each successful call records one unit with source `external_tool`.

### 4. An in-app assistant shortfall is owed, not forgiven

The in-app assistant is admitted when the organisation's usage-credit balance is above zero, and a turn can make up to 12 model calls. Before this decision `consumeCredits` clamped each debit to the balance left and dropped the rest, so the last turn before a balance ran out, and turns running at the same time, were partly unbilled. Now the unpaid remainder of a `consume_assistant_tokens` debit is kept as a debt, in the same per-reason carry the sub-credit remainder already uses (`org_billing_settings.meter_carry_micro_credits_by_reason`). The next charge under that reason collects it first. The next grant or top-up collects it before the balance mirror moves. The credit gate treats the balance less the debt as the balance. Lots are still never drawn below zero. This refines ADR-053 §3.

The recall of workspace memory that opens each turn now runs inside the turn's frame (`runWithinEnclosingAction`, `packages/oxagen/src/kernel.ts`). It had run as a top-level invoke, so every turn cost one governed action unit, contrary to ADR-053, and an exhausted bucket silently switched recall off. A nested invoke also no longer meets the GAU admission gate, because it never draws a unit. The budget gate still applies to it.

### 5. Statements cover any period longer than two days

`get_billing_statement` and `export_billing_statement` produce a statement for a UTC week, month, quarter or year, or for a custom half-open window longer than 48 hours and no longer than 366 days. A statement carries the terms in force, governed action units by source, workspace, agent, operator and capability or tool, the month buckets it overlaps, the settlements, prepaid orders and invoices in the period, and the usage-credit movements with opening and closing balances. The CSV export itemises every ledger row. The HTML export is a printable document. `pnpm billing:statement` produces either for the platform operator.

### 6. Enterprise orders are paid in advance on an invoice

`billing.prepaid_orders` records an order a platform operator issues with `issue_prepaid_invoice` (platform-only). One order carries up to three lines on one Stripe invoice: the platform licence for a period, prepaid governed action units at the contracted rate, and prepaid usage credits for the in-app assistant. The units and credits are granted when the invoice is paid, or when it is issued for an order the operator marks `grant_on = 'issue'`. The grant is idempotent on the order. `set_contract_terms` (platform-only) writes the negotiated terms that `billing.contract_terms` previously received only by hand. A customer tops up at any time by card through `purchase_credits`, or the operator issues another prepaid order.

## Alternatives

**Keep the ledger in ClickHouse.** ClickHouse holds append-only telemetry and would store the volume cheaply. It cannot commit in the same transaction as the bucket, so the itemisation and the balance could disagree, and it deduplicates asynchronously, so it cannot decide whether a retry has already been billed. Rejected for the record that money is reconciled against. ClickHouse keeps the per-call telemetry it already has.

**Deduplicate on the request id.** The in-app agent answers several tool calls under one request id, so this would bill the second tool call of a turn as a retry of the first. Rejected.

**Keep wrapped-harness tool calls free.** This was the prior behaviour. The maintainer rejected it on 2026-09-23. Governing those calls is the work customers pay for.

**Bill every Tacho event, or bill at the hook.** A tool call produces more than one event (pre and post hooks, collector and hook sightings), and a price per event would move with the harness's telemetry rather than with the work. Rejected in favour of one unit per allowed tool call.

## Consequences

- An invoice line, a statement and the ledger rows reconcile by addition, and every unit names what incurred it.
- The ledger grows by one row per billed action. At 25 million actions a year an organisation adds about 25 million rows a year to one table, indexed on `(org_id, billed_at)`. Partitioning by `billed_at` is the next step when a single organisation's volume makes the index expensive. Rows are retained as long as the invoices they support.
- Bills for customers who run wrapped harnesses rise, because tool calls that were free now cost a unit each. Rates and allowances are unchanged, and the spec's run-class conversion needs re-deriving from production data.
- Accrual on the kernel path stays best-effort after the action succeeds (ADR-052). Tacho accrual fails the ingest request instead, so the host re-sends the batch and the ledger deduplicates it.
- A billing failure that never clears would hold a host's later batches behind the one it refuses, because the host retries until it gets a 2xx. A transient failure recovers on its own. No deterministic failure is known: the entry builder always names a subject, so the ledger's CHECK cannot refuse a row. If one appears, the fix is a sweep that rebuilds entries from `tacho_events` (the keys are deterministic, so a sweep cannot bill twice) and a bound on the retries.
- Background work that charges `consume_assistant_tokens` (run summaries, schema reconciliation) now owes its shortfall at a zero balance as well, and a debt settled from a grant counts against the month's assistant spend cap when it is paid.
