# Verified-Outcome Market Router: Enhancement Roadmap

Phases are ordered by dependency, not calendar. Each phase is shippable on its own and
each one deepens the wedge: metering to billing, contract governance, and verified
outcomes as a product. Phase 0 is in the tree today; everything after it is planned.

---

## Phase 0 (shipped, this PR): the data spine and the decision core

What landed, in one line each:

- `router_outcomes` ClickHouse table: per (task class x model) verified-success +
  cost + latency record, tenant-scoped, append-only.
- `deriveTaskClass()`: stable task-class keys aligned with the deterministic
  classifier's vocabulary.
- `decideMarketRoute()`: pure cheapest-eligible-venue selection with full candidate
  audit trail; deterministic fallback when data is sparse.
- Judge-rejection escalation ladder (fast to balanced to precise) in the revise loop.
- Routing policy (`off` / `shadow` / `enforce`) per org/workspace with capability
  surfaces on API and MCP: `get_routing_policy`, `set_routing_policy`,
  `list_routing_stats`, `preview_routing_decision`.
- Shadow mode records outcomes for whatever actually ran, so curves accumulate at
  zero behavior risk.

Exit criteria met when: shadow mode is on for internal workspaces and
`list_routing_stats` returns non-empty curves for the top task classes.

---

## Phase 1: trust the data (shadow to enforce)

The gate between "we compute curves" and "we act on curves" is statistical, not
architectural. This phase makes the curves trustworthy enough to enforce.

- **Confidence-aware eligibility.** Replace the raw success-rate threshold with a
  Wilson lower bound (or Beta posterior) so a venue with 20/20 successes is not
  treated like one with 2000/2000. Policy gains a confidence parameter; `minSamples`
  becomes a floor, not the whole story.
- **Hierarchical pooling.** Small tenants never accumulate enough per-class samples.
  Blend tenant-local curves with platform-global curves (shrinkage weighting by
  sample count), with a policy switch for tenants who want strictly local data.
- **Backfill from existing signals.** Seed curves from `eval_item_results` (judged
  accuracy per model) and bench `eval_results` (suite/task pass + reward per model)
  so enforce mode is viable on day one for well-covered classes.
- **Persist executed-test verification for production runs.** Today `testsPassed` is
  in-flight only. Wire the verify-auto result into `router_outcomes` for every
  production run that executes tests: it is the strongest correctness signal we have.
- **Staleness handling.** Windowed curves (default 30 days) with recency weighting so
  a model that regressed last week is not carried by last quarter's wins.
- **App dashboard (UI capability parity).** Declare the `app` layer on the routing
  capabilities and ship the routing page: Pareto scatter (cost x verified rate) per
  task class with reaviz, policy editor, shadow-vs-enforce diff view
  ("what would the market router have done, and what would it have saved").

Exit criteria: enforce mode on for at least one internal workspace with a measured
cost reduction at flat-or-better verified success rate.

## Phase 2: live economics

Prices and models drift; the router must re-fit continuously. This phase removes every
hand-maintained input.

- **Live price sync.** Fetch AI Gateway `/v1/models` pricing on a schedule (Inngest),
  diff against the rate card, update the stored card, and emit a price-drift event.
  Today both rate cards are transcribed by hand; that is a correctness risk the
  router inherits.
- **Materialized curves.** A scheduled job precomputes per-class Pareto frontiers into
  a compact store so routing reads are O(1) at turn start instead of a live GROUP BY.
- **Budget-aware objective.** Today: cheapest venue clearing the threshold. Add the
  dual: maximize expected verified success subject to the per-turn budget guard
  (`turn-budget.ts`), so the router and the budget system solve one problem instead
  of two. Escalation repricing becomes exact.
- **Latency as a third axis.** Some venues are cheap and accurate but slow. Surface
  p50/p95 latency per venue in the curve and let policy weight it (interactive
  surfaces care; batch fleets do not).
- **New-model onboarding.** When the gateway lists a new model, it enters the curve
  automatically at zero samples and becomes routable the moment it clears the
  confidence gate (see Phase 3 for how it gets samples).

Exit criteria: a gateway price change or new-model listing changes routing decisions
within one sync cycle with no human involvement.

## Phase 3: learned signatures and exploration

Regex task classes are a bootstrap. This phase learns the structure of the work.

- **Learned task signatures.** Replace regex classes with clustered prompt
  embeddings (plus structural features: file count, cross-package, capability,
  origin type). Signatures become stable learned keys; the classifier's regex
  vocabulary remains only as human-readable labels for the clusters.
- **Contextual bandits for explore/exploit.** A pure exploit router never discovers
  that a new cheap model clears the bar. Route a small policy-capped exploration
  share (Thompson sampling over the Beta posteriors) to under-sampled venues,
  in shadow-verified fashion where possible (run cheap venue, verify hard, record).
  Exploration spend is metered and visible: it is a line item, not a leak.
- **Verifier-integrated datasets.** Auto-build eval datasets per task signature from
  metered traces (`eval.dataset.from_traces` already exists) and run scheduled evals
  against new venues before giving them production traffic: a paper-trading phase
  for models.
- **Per-role curves.** Extend beyond the worker: judge and triage roles get their own
  curves (a judge only needs to be accurate at judging, which cheaper models often
  are). Preserve the judge-independence invariant (judge is never the worker model).

Exit criteria: at least one model promoted from exploration to a routable venue on a
production task class with no human in the loop.

## Phase 4: billing-native accuracy SLAs (the endgame)

The pure Stripe-for-agents move nobody else can make, because it needs metering,
verification, and billing in one loop.

- **SLA objects.** A new contract object attached to a task class and a workspace:
  "at least 95 percent verified success at or under $0.50 per task." SLAs are typed,
  versioned, and priced; they ride the same accountability chain as every other
  contract (identity, scope, action, terms, verified outcome, audit record).
- **Automatic remediation.** When a period closes below the SLA bar, credits are
  refunded automatically through the existing credit ledger (a new
  `sla_refund` ledger reason beside today's grant reasons), enforced by the same
  metering-to-Stripe loop that billed the usage. No ticket, no dispute thread.
- **Attainment reporting.** Per-invoice SLA attainment statements, queryable and
  auditable: which task classes, which venues, what verified rate, what was refunded
  and why. This is the artifact a buyer's finance team has never seen from an AI
  vendor.
- **Reseller pass-through.** Teams that build and resell agents on Oxagen can publish
  their own SLAs to their customers, backed by the platform's curves, with their own
  margin on top. The router's guarantees become their product's guarantees.
- **Marketplace pricing of accuracy.** Published agents and skills carry an accuracy
  SLA and a price as first-class listing metadata. Buyers compare guaranteed
  outcomes, not marketing claims.

Exit criteria: first customer invoice carrying an SLA attainment statement, and first
automatic refund issued by the loop with a full audit trail.

---

## Standing constraints (all phases)

- **Default-off and pin-wins.** A manual model pin always beats the market router.
  New modes never change behavior for tenants who did not opt in.
- **Judge independence.** The judge model is never the worker model, in every phase.
- **Store boundaries.** Curves and outcomes are ClickHouse; policies and SLAs are
  Postgres; nothing crosses the infrastructure boundary rules in `CLAUDE.md`.
- **Capability parity.** Every new surface ships contract first, then API, MCP,
  and (from Phase 1) app UI with proof, per the UI capability parity law.
- **Auditability beats cleverness.** Every routing decision, exploration allocation,
  and refund must be explainable from stored records. If a phase's mechanism cannot
  produce an audit trail, it does not ship.
