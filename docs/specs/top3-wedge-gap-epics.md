# Top-3 Wedge Plays — Product Gap Assessment & Epic Roadmap

> Audit date: 2026-07-07. Three parallel read-only codebase audits (permission-scoped
> retrieval, entitlements + metering, outcome verification) with file:line evidence.
> Companion to `docs/VISION.md` → "The gap — nobody enforces the accountability chain".

> **2026-07-21 launch-boundary correction:** the client-authored execution/file
> graph and its `get_execution_lineage` read surface were retired. The exact live
> code graph stays local to each checkout/worktree; Oxagen retains stable provider,
> repository, ref, commit, pull-request, workflow-run, and changed-file metadata.
> Canonical topology derived from configured protected/default refs and a typed
> evidence ledger for verified execution-to-artifact/file claims are follow-ups.
> Durable execution traces and the hash-chained audit log remain.

## The three plays (from the wedge stack rank)

1. **Permission-scoped context plane** — RBAC enforced *inside* graph retrieval, per
   query, per principal, per tenant: the agent can only know what its principal could
   know. Sold to regulated enterprises deploying coding agents.
2. **Capability-contract entitlements + metering for agent-native ISVs** — one
   primitive that enforces what a customer's agents may do AND meters it for billing;
   the ISV resells governed agent capability to *their* customers.
3. **Outcome verification layer** — structurally verify agent work (diff merged,
   tests passed, blast radius contained) and sign the meter event, enabling
   trustworthy outcome-based pricing.

## Executive summary

**One root cause underlies all three gaps: the principal is dropped at the kernel
boundary.** IAM resolves who is calling, then throws the identity away — handlers
receive tenant scope (`orgId`, `workspaceId`) only, meter rows carry no
principal/agent/capability dimension, and outcome records don't exist at all. Every
play needs the same spine built first: carry identity end-to-end, then attach scope
(play 1), commercial terms (play 2), and verified outcomes (play 3) to it.

| | Play 1: Permission-scoped context | Play 2: ISV entitlements + metering | Play 3: Outcome verification |
|---|---|---|---|
| **Verdict** | Not close — tenant-scoped, never principal-scoped | Real single-tenant primitive; reseller story not built | Strong raw material; verification-to-signed-meter spine missing |
| **Strongest existing asset** | Fail-closed org+workspace scoping (`packages/tenancy/src/scope.ts`) | Entitlement gate at `invoke()` (`packages/plugins/src/entitlements/`) + per-turn budgets | Durable execution trace + hash-chained audit log; typed file-evidence ingest remains a gap |
| **Biggest gap** | No node/edge ACLs; principal never reaches Cypher | No sub-tenancy; usage never reported to Stripe; org-grained metering only | No first-class outcome events; meter rows unsigned and mutable |

### What genuinely exists (the assets to build on)

- **Tenant isolation is real and mostly fail-closed.** Ontology queries filter every
  node and path by org + workspace (`packages/handlers/src/ontology.query.ts:156`),
  scope construction throws on missing tenancy (`packages/tenancy/src/scope.ts:22`),
  and capability IAM denies loudly on resolver failure (`packages/oxagen/src/kernel.ts:640`).
- **Capability-level governance is live.** Typed contracts + IAM + the entitlement
  runtime (`bootstrapEntitlementRuntime()`) gate every plugin-claimed capability per
  workspace at `invoke()` time, editable at runtime via `plugin.org.install`/`set_enabled`.
- **Metering and budget enforcement work — at org grain.** Single charge chokepoint
  (`packages/billing/src/metering.ts:124`), atomic credit debits, pre-turn admission,
  and 3-mode per-turn USD budgets shared across CLI/API/app.
- **Trace capture is the strongest area.** `agent.execution.record` persists nested
  steps with per-tool tokens/latency; ClickHouse rows are OTEL-stamped with
  trace/span ids. IAM audit events are principal-attributed and hash-chained
  (`packages/iam/src/emit-audit.ts:117`). Verified file attribution remains an
  evidence-ledger gap rather than an automatic graph edge.
- **An eval loop and CI/PR readers exist** (`eval.run.start` with LLM judge;
  `repo.ci.status`, `repo.pr.get`) — the ingredients of verification, unwired.

### The gaps, bluntly

- **Play 1:** Retrieval is a pure function of `(orgId, workspaceId)` — two users in a
  workspace see identical graphs by construction. No ACL field exists on any node or
  edge, and connectors do not fetch source-system permissions (Google Drive's sharing
  list is not retrieved). Audit rows have `target_id` hard-coded null, so "who read
  node N" is unanswerable; `IAM_ENFORCEMENT_ENABLED=false` is a global bypass. The
  local code graph is outside this shared retrieval plane.
- **Play 2:** `token_usage` has no principal/agent/capability/end-customer column —
  per-seat or per-customer pricing is structurally impossible. Billing is a **prepaid
  credit wallet**, not a metered Stripe loop: usage is never pushed to Stripe. No
  sub-tenant entity, no Stripe Connect, no revenue share, no ISV-defined plans. API
  keys carry a `scope` jsonb that is written but never read. Rate card prices only
  Anthropic + OpenAI.
- **Play 3:** No outcome event exists anywhere — execution status tops out at
  `completed/failed`; CI/PR state is read live and never persisted against the
  execution that produced it. Meter tables are plain mutable `MergeTree` with no
  idempotency keys, hashes, or signatures. The audit hash-chain omits payload,
  outcome, principal, and timestamp from the chained hash (edits don't break it), is
  unsigned, and unanchored. Billing has no outcome/per-resolution price type.
  The executed-test verification harness exists only offline in `packages/bench`.

---

## Epics, in implementation order

Ordering logic: **Epic 1 is the keystone** — nothing downstream has an identity to
filter, meter, or attest until it lands. Epics 2–4 win play 1 (fastest to claim,
matches the #1-ranked wedge). Epics 5–6 build play 2's foundation on the new
dimensions. Epics 7–8 build play 3 on the hardened lineage. Epics 9–10 are the
monetization capstones that need everything beneath them.

### Epic 1 — Principal-to-data spine *(enabler for all three plays)*
Carry the resolved principal from IAM through the kernel into every downstream layer.
- Add `principalId` (+ acting-agent id, human-originator id) to `TenantScope`
  (`packages/tenancy/src/scope.ts:4`) and pass `CheckedContext` — not the stripped
  `CapabilityContext` — to handlers (`packages/oxagen/src/types.ts:232`).
- Add `principal_id`, `agent_id`, `capability_name` columns to ClickHouse
  `token_usage` / `tool_invocations` and thread them through `chargeCostUsd` and the
  usage rollups. (Fixes the known `principal_id` P0.)
- Populate audit `target_kind`/`target_id` (`packages/iam/src/emit-audit.ts:134`) so
  reads become attributable to what was read.
- **Done when:** any capability invocation can answer *who initiated → which agent →
  which tool → what data* from stored rows alone, and usage can be grouped per
  principal/agent/capability.

### Epic 2 — Tenant-isolation trust floor *(play 1 credibility; small, urgent)*
Fix the defects that would sink a governance pitch in the first security review.
- Verify every remaining workspace-graph query and provider-metadata projection
  constrains both org and workspace; the exact code graph remains local.
- Replace the substring `SCOPE_GUARD` regex with a predicate that requires org AND
  workspace (and later principal) clauses (`packages/ontology/src/tenant.ts:8`).
- Remove or break-glass-gate the `IAM_ENFORCEMENT_ENABLED=false` global bypass
  (`packages/oxagen/src/kernel.ts:680`); close builtin-capability always-allow
  defaults with an org-level policy.
- **Done when:** no query path can return cross-workspace data and no env var can
  silently disable enforcement.

### Epic 3 — Node/edge ACLs + principal-scoped retrieval *(play 1 core)*
Make "the agent can only know what its principal could know" true at the Cypher level.
- ACL dimension on graph nodes/edges (`allowedPrincipalIds` / group refs /
  `sourceAclHash`) stamped at ingest (`packages/ingestion/src/mutations/upsert-entity.ts:131`).
- Principal-membership predicate compiled into every retrieval query
  (`ontology.query.ts:157`, `ontology.neighbors.ts:131`, provider/evidence projections),
  default fail-closed for ACL-bearing nodes; IAM group/role resolution feeding the predicate.
- Per-principal retrieval audit: every graph read logs the node/edge ids returned
  (audit `target_id` from Epic 1).
- **Done when:** two users in one workspace get different graph slices matching their
  ACLs, and "who has read node N" is a query.

### Epic 4 — Source-ACL sync in connectors *(play 1 completion)*
Ground the ACLs in the source systems the graph ingests.
- Fetch native permissions at ingest (start: Google Drive `permissions` list, GitHub
  repo collaborators/teams for shared provider metadata) and map them to Oxagen principals.
- Re-sync/drift handling: permission revocations propagate to graph ACLs (async
  Inngest, same dual-write pattern as connector ingestion).
- Repo-level permission model for shared repository metadata and any future
  protected-ref topology — a repo an engineer cannot read in GitHub is invisible to
  their Oxagen retrieval. Local code-graph access follows the checkout's own credentials.
- **Done when:** revoking a document/repo in the source removes it from that
  principal's retrieval within the sync SLA.

### Epic 5 — Scoped principals & keys *(play 2 foundation, play 1 adjacent)*
Turn the dead `scope` field into the mintable, governable agent/end-customer identity.
- Enforce `api_keys.scope` at resolution (`packages/auth/src/resolvers/api-key.ts:91`)
  — capability allowlists, workspace pins, graph-scope caps.
- Mint keys per agent / per end-customer with distinct entitlements; attribution
  flows automatically via Epic 1 dimensions.
- Admin usage surfaces grouped by capability / agent / principal (today: model-only).
- **Done when:** an org can mint a key limited to named capabilities + a knowledge
  scope, and see that key's usage itemized.

### Epic 6 — Usage→Stripe metered billing loop *(play 2 core)*
Make the "ClickHouse→Stripe loop" literal instead of a prepaid wallet.
- Report usage to Stripe meter events (or usage records) from the rollup pipeline;
  keep the credit wallet as one plan option, not the only mechanism.
- Extend the rate card beyond Anthropic/OpenAI to all gateway vendors; per-customer
  margin/pricing overrides.
- Entitlement grants richer than binary install: quantity limits, rate caps,
  per-capability quotas tied to plans.
- **Done when:** a customer on a metered plan receives a Stripe invoice line derived
  from observed ClickHouse usage, per capability.

### Epic 7 — First-class outcome events *(play 3 core)*
Persist verified outcomes as durable, joinable facts — not live reads.
- New `outcome.record` / `verification.assert` contracts: Postgres outcome table +
  ClickHouse events + Neo4j edge joining outcome → `:Execution` lineage.
- Persist CI/PR verdicts (webhook or poll) against the execution that produced the
  change: `tests_passed@sha`, `pr_merged`, and blast radius from an immutable,
  typed run-evidence manifest bound to the exact commit and declared scope.
- Bring the `packages/bench` executed-test harness in-runtime as deterministic
  verification rules; LLM-judge evals become one (subjective) verifier among several.
- **Done when:** "show me executions whose diffs merged with green CI" is a query,
  per customer, in production.

### Epic 8 — Signed, tamper-evident meter & outcome envelope *(play 3 trust)*
Upgrade integrity from "append-only by convention" to third-party verifiable.
- Idempotency keys + dedup on the meter write path (`insertRows`); ReplacingMergeTree
  or equivalent immutability posture on meter/outcome tables.
- Strengthen the hash chain to commit payload, outcome, principal, and timestamp
  (today's chain omits all four — `emit-audit.ts:102`); extend it beyond IAM events
  to meter and outcome events.
- Sign the `{execution, lineage, verdict, meter}` bundle via the existing KMS seam
  (`packages/crypto`), with periodic external anchoring.
- **Done when:** a customer (or their auditor) can independently verify that a meter
  event's outcome and amount were not altered after emission.

### Epic 9 — Sub-tenancy & reseller billing *(play 2 capstone)*
The ISV story: Oxagen customers govern, meter, and bill *their* customers.
- End-customer entity below org→workspace; ISV-defined plans, prices, and
  entitlement bundles applied to their end-customers' principals/keys (Epic 5).
- Per-end-customer usage export and invoicing; Stripe Connect (or usage-export-first
  as the neutral BYO-billing option) with revenue share.
- White-label surfaces for the ISV's customer-facing usage/billing views.
- **Done when:** an ISV onboards an end-customer, assigns a plan, and that
  end-customer's agent usage lands on the end-customer's invoice.

### Epic 10 — Outcome-priced billing + compliance evidence plane *(capstone)*
Monetize verification; close the loop for "a compliance officer signs off."
- New price type in `packages/billing/src/pricing.ts`: per-resolution / success-fee,
  chargeable only against a **signed outcome event** (Epics 7+8) — the attestation IS
  the meter.
- Evidence exports: replayable accountability-chain reports (who → agent → tool →
  data → terms → outcome → audit) mapped to EU AI Act / NIST AI RMF / SOC 2 asks.
- **Done when:** a customer can price a capability per verified outcome, and export
  auditor-ready evidence for any billed outcome.

---

## Sequencing at a glance

```
Epic 1 (principal spine) ──┬── Epic 2 (trust floor) ── Epic 3 (graph ACLs) ── Epic 4 (source-ACL sync)   → Play 1 sellable
                           ├── Epic 5 (scoped keys) ── Epic 6 (Stripe loop) ── Epic 9 (sub-tenancy)      → Play 2 sellable
                           └── Epic 7 (outcome events) ── Epic 8 (signed envelope) ── Epic 10 (outcome pricing + evidence) → Play 3 sellable
```

Plays 1 (Epics 1–4), 2 (Epics 5–6, 9), and 3 (Epics 7–8, 10) can proceed in parallel
after Epic 1; the single-file order above is the recommended priority when
serialized, matching the wedge stack rank while front-loading the shared spine and
the security defects that would fail an enterprise review.
