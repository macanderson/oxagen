# The Verified-Outcome Market Router

**Accuracy with an SLA and a price tag.**

This spec covers the learned, economic model router: the feature that turns Oxagen's
existing per-function model routing into a market mechanism grounded in the platform's
own verified history, and eventually into a billable, guaranteed product. It is the
purest expression of the Stripe-for-agents wedge (`docs/VISION.md`): the same loop that
meters and bills usage becomes the loop that prices, guarantees, and refunds accuracy.

- `roadmap.md`, the phased enhancement roadmap from today's v1 to billing-native
  accuracy SLAs.
- Slide deck: `apps/docs/public/decks/verified-outcome-router/` (served at
  `/decks/verified-outcome-router` on docs.oxagen.sh).

## The one-sentence pitch

Every subtask class gets a live cost/accuracy curve computed from Oxagen's own
ClickHouse history (verified successes per model per task class, at current rate-card
prices), and the router treats each subtask like an order routed to the cheapest venue
that clears the verified-success threshold, escalating tiers only when the verifier
rejects.

## What existed before this feature (current state, audited 2026-07-10)

Model choice on the platform was deterministic and hand-tuned. Three independent layers,
none of them learned:

1. **A deterministic tier router.** `packages/agent-engine/src/router/model-router.ts`
   classifies a task by regex and breadth signals (`classifyTier`) into
   fast / balanced / precise tiers mapped to concrete gateway slugs
   (Haiku / Sonnet / Fable by default). It never looks at outcomes. A high-stakes
   domain regex (auth, billing, security, migrations, architecture) forces the precise
   tier; everything else is vocabulary heuristics.
2. **Per-function human overrides.** The `/worker-model`, `/judge-model`, and
   `/triage-model` commands persist per-role model pins through settings into env
   (`OXAGEN_MODEL`, `OXAGEN_LLM_ADVISOR`, `OXAGEN_LLM_EVALUATOR`), consumed fresh each
   turn by the engine. A pin always wins over the classifier.
3. **A hand-synced rate card.** `packages/agent-engine/src/router/rate-card.ts` carries
   per-1M-token prices transcribed by hand from the AI Gateway model list, with
   `compareModels()` able to price identical usage across every family cheapest-first.
   A twin lives in `packages/billing/src/pricing.ts` for actual billing. Nothing
   fetches live prices.

Meanwhile the platform already produced everything a learned router needs, in three
stores that were never joined:

- **Cost, billing-grade.** ClickHouse `token_usage` records every LLM call (model,
  provider cost in micros, capability, surface, prompt hash, latency; 365-day TTL).
  Every call funnels through `@oxagen/ai`, so coverage is total.
- **Correctness, fragmented.** Evals v1 (`eval_item_results`: model, judge model,
  score, passed, tenant-scoped) is the cleanest signal; the judge/revise loop in the
  agent engine produces verdicts every turn; executed-test verification
  (`testsPassed`) is the strongest signal but was consumed in-flight and persisted
  only for bench runs.
- **Completion, unattributed.** Postgres `agent_executions` records success/failure
  per run but has no model column.

Two structural gaps defined the opportunity: no durable record joining
(task class x model) to verified success and cost, and no tier escalation when the
judge rejected a result (the revise loop re-ran the same model).

## What v1 ships (this PR)

The data spine, the decision core, and the governance surfaces, flag-gated so default
behavior is unchanged:

1. **`router_outcomes`** ClickHouse table: the missing joined record. One row per
   routed unit of work: task class, signature hash, model, tier, verified (with
   source: tests beat judge beats completion), score, provider cost, latency,
   routing mode. Tenant-scoped, append-only, 365-day TTL.
2. **Market router decision core** (`market-router.ts`): a pure function. Eligible
   venues are models whose verified success rate clears the policy threshold with
   enough samples; the router picks the cheapest eligible venue by observed cost;
   sparse data falls back to the deterministic classifier. Every decision returns the
   full candidate table as an audit trail.
3. **Escalation ladder.** When the judge rejects and policy allows, the revision round
   escalates one tier (fast to balanced to precise) instead of retrying the same
   model.
4. **Policy and governance.** Per-org/workspace routing policy with three modes:
   `off` (today's behavior, the default), `shadow` (compute and record decisions
   without acting on them), `enforce` (route by the market). Four capabilities,
   named per ADR-025 and wired across API and MCP:
   `get_routing_policy`, `set_routing_policy`, `list_routing_stats`,
   `preview_routing_decision`.
5. **Shadow-mode learning loop.** In shadow mode every turn records what actually ran
   and whether it verified, so the Pareto curves fill up with zero behavior risk
   before anyone flips enforce.

## Why this feature is the wedge, not a feature

Routing by learned cost/accuracy curves requires owning three things at once: the
metering exhaust (what did it cost), the verification loop (did it actually work), and
the billing rail (charge or refund accordingly). Competitors own at most one.
Observability vendors see cost but not verified outcomes. Eval vendors see outcomes
but neither meter nor bill. Framework vendors own the loop but none of the
accounting. Oxagen's accountability chain (identity, scope, action, terms, verified
outcome, audit record) is exactly the substrate a market router needs, which is why
the endgame (billing-native accuracy SLAs with automatic credit refunds) is a move
nobody else can make. Accuracy stops being a vibe and becomes a priced, guaranteed,
auditable product.
