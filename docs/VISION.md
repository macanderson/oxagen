# Oxagen Vision — the Stripe for Agents

> **Mission: Oxagen is the metered, governed, graph-grounded control plane for teams that
> build and resell AI agents — the neutral Stripe-for-agents.**

This document is the north star for every product and engineering decision. Feature
recommendations, roadmap priorities, and architecture choices are judged against it —
by humans, by coding agents (see `CLAUDE.md` → *Mission*), and by the automated
Vision Gate in CI (`.github/workflows/vision-gate.yml`), which LLM-judges every PR
diff against this file and flags drift.

## Positioning

Oxagen does not compete where it loses. It will not out-Glean Glean on connector
breadth and graph maturity, out-eval Braintrust, or out-mindshare LangGraph. The
single wedge where a platform of Oxagen's exact shape can credibly be #1:

**The metered, governed, graph-grounded control plane for teams that build and resell
AI agents.**

Own the intersection no incumbent bundles:

1. **Governance** — capability-parity typed contracts that make every MCP tool
   inherently governed and un-poisonable. Every capability is a typed contract with
   IAM + entitlement enforcement, exposed with parity across API, MCP, CLI, and UI.
2. **Grounding** — a Neo4j graph + ontology that grounds agent answers in cited,
   time-aware context. Accuracy is the product, citations are the proof.
3. **Monetization** — a ClickHouse→Stripe loop that turns observed agent usage
   directly into customer billing. Not spend dashboards; revenue infrastructure.

That is not "another agent framework" or "another enterprise search box." It is
**usage-based-billing-plus-governance infrastructure for AI products**, with the
knowledge graph as the **accuracy moat** and vendor-neutral BYOK as the **trust moat**.

## Market gaps we own (underserved needs nobody bundles)

1. **Meter-to-revenue billing infrastructure for agents.** The clearest whitespace.
   Observability tools show spend; FinOps tools do internal chargeback; nobody lets a
   company *reselling* AI meter observed agent usage and bill their customers through
   it. Oxagen already has the ClickHouse→Stripe loop. Verified: uncontested.
2. **Governed, schema-enforced, metered MCP tools as an anti-poisoning story.** The
   market fears tool poisoning/injection (OWASP entry, ~200K vulnerable instances),
   but gateways only inspect third-party servers. A platform whose tools are natively
   typed contracts with IAM + entitlement enforcement is a different, stronger trust
   posture. Underserved.
3. **Graph-grounded accuracy/citations with time-aware fact validity.** Graphiti
   proved bi-temporal graphs improve reasoning accuracy, but as a thin-funded library.
   Nobody offers hosted, multi-tenant, citation-backed, time-aware graph grounding as
   a product. Real gap.
4. **Vendor-neutral agent platform (no cloud gravity).** Every full platform pulls
   toward a cloud (Azure/GCP) or a model (OpenAI/Anthropic/Cognition). A credibly
   neutral, BYOK, self-hostable-or-hosted platform is underserved — especially for
   teams burned by OpenAI's AgentKit deprecation and Microsoft's forced AutoGen/SK
   migration.
5. **Fleet-scale agent coordination with typed lineage + metering.** Everyone ships
   "parallel agents"; nobody offers structured fan-out where each agent grounds in a
   shared typed graph and every step emits lineage + cost. Partially owned by no one —
   but requires proof to claim.

## Go-to-market tailwinds

- OpenAI killed its governance/eval layer (AgentKit shutdown Nov 30, 2026).
- Microsoft forced a painful AutoGen/Semantic Kernel migration.
- The market is actively cutting AI spend — metering and cost attribution are budget
  line items, not nice-to-haves.
- Tool-poisoning fear is driving demand for exactly the typed-contract governance
  Oxagen already enforces.

Win by being the neutral Stripe-for-agents that also happens to ground every action in
a governed graph — then earn evals and connector breadth as **fast-follows, not the
front line**.

## What advances the vision

Work that strengthens the wedge:

- Metering coverage: every capability, agent step, and LLM call emits usage events
  that can be priced and re-billed (`invoke()` metering, `@oxagen/ai` telemetry,
  Stripe meter sync).
- Contract governance: new capabilities land as typed contracts with IAM +
  entitlement gates and full API/MCP/CLI/UI parity; nothing ships as an ungoverned
  tool surface.
- Graph grounding: agent answers cite nodes/edges with time-aware validity;
  ingestion and ontology work that deepens cited, multi-tenant grounding.
- Vendor neutrality: BYOK paths, model/provider abstraction (`modelIdOf()`, the AI
  Gateway), self-hostable surfaces, and zero hard vendor lock-in.
- Fleet lineage: fan-out/coordination primitives whose every step emits typed
  lineage + cost (`agent.subagent.dispatch`/`aggregate`).
- Reseller ergonomics: anything that makes it easier for a customer to package,
  govern, meter, and bill *their* agents to *their* customers.

## What is drift

- Building standalone eval tooling, connector breadth for its own sake, or framework
  mindshare plays **as the front line** (they are permitted as fast-follows once the
  wedge is won, and as thin layers in service of the wedge).
- New capabilities or tool surfaces that bypass typed contracts, IAM/entitlement
  gates, or metering ("just this once" untyped/unmetered paths).
- Agent answers or UI surfaces that present ungrounded, citation-free output where
  graph grounding applies.
- Hard-coupling to a single model vendor or cloud (hard-coded model slugs, provider
  lock-in, features that only work on one cloud).
- Fan-out/orchestration that emits no lineage or cost accounting.
- Storing data across the four-store boundaries in ways that break the metering or
  grounding story (see `CLAUDE.md` → *Infrastructure boundaries*).

**Not drift:** bug fixes, refactors, tests, CI/tooling, docs, dependency hygiene,
performance work, and maintenance of existing surfaces. Routine engineering that
keeps the platform healthy is neutral by definition — the gate exists to catch
strategic drift, not to nag maintenance.

## Drift tests (the questions the Vision Gate asks)

1. Does this change help a team that builds and resells AI agents meter, govern,
   ground, or bill their product? (advances)
2. Does it add a capability without a typed contract, IAM/entitlement gate, or
   metering? (drifts)
3. Does it present agent output without citations where graph grounding applies?
   (drifts)
4. Does it couple the platform to one vendor/cloud where a neutral abstraction
   exists? (drifts)
5. Is it front-line investment in a market we explicitly declined to fight
   (connector breadth, standalone evals, framework mindshare)? (drifts)
6. Is it routine maintenance, fix, test, or tooling work? (neutral)
