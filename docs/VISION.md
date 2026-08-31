# Oxagen Vision — the Stripe for Agents

> **Mission: Oxagen is the metered, governed, graph-grounded control plane for teams that
> build and resell AI agents — the neutral Stripe-for-agents.**

This document is the north star for every product and engineering decision. Feature
recommendations, roadmap priorities, and architecture choices are judged against it —
by humans, by coding agents (see `CLAUDE.md` → *Mission*), and by the automated
Vision Gate in CI (`.github/workflows/vision-gate.yml`), which LLM-judges every PR
diff against this file and flags drift.

## The gap — nobody enforces the accountability chain

Despite the explosion of agent tooling, **90% of organizations have no way to govern
what agents in production are actually doing, and 54% have already had a security
incident caused by an agent acting unexpectedly.** The reason is structural — every
existing layer covers one link and stops:

- **Identity** says *who the agent is* — and nothing more.
- **Gateways** say *which tools it can call* — but most only handle routing, some
  handle authentication, and very few handle the full accountability chain: who
  initiated the task, which agent acted, which tool was called, and what data was
  accessed.
- **Billing** says *what it consumed* — but can't stop anything.

Nobody binds **identity → knowledge scope → permitted action → commercial terms →
verified outcome → audit record** into one enforced object. That object is Oxagen's
**contracted-capabilities ontology**: every capability is a typed contract that
carries the caller's identity, the graph scope it may read, the action it is
entitled to take (IAM + entitlements), the commercial terms it is metered and billed
under, the outcome it verifiably produced, and the audit record it leaves behind —
enforced at invocation time, not reconstructed after the incident.

Even the official MCP 2026 roadmap names audit trails, enterprise-managed auth, and
gateway patterns as open gaps: the protocol layer itself is asking for what Oxagen's
contract layer already is. The wedge below is how we own that answer.

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
   The contract is the one enforced object that binds identity → knowledge scope →
   permitted action → commercial terms → verified outcome → audit record — the full
   accountability chain, not just routing or authentication.
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
3. **The enforced accountability chain.** Identity vendors, gateways, and billing
   tools each cover one link; none binds who initiated the task, which agent acted,
   which tool was called, what data was accessed, under what commercial terms, with
   what verified outcome and audit record — into one object enforced at invocation.
   90% of organizations can't govern what production agents actually do; 54% have
   had an agent-caused security incident; the MCP 2026 roadmap itself lists audit
   trails, enterprise-managed auth, and gateway patterns as open gaps. Oxagen's
   contracted-capabilities ontology *is* that object. Uncontested as a bundle.
4. **Graph-grounded accuracy/citations with time-aware fact validity.** Graphiti
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
- Accountability chain: work that binds the links of identity → knowledge scope →
  permitted action → commercial terms → verified outcome → audit record more tightly
  into the contract object — principal attribution (who initiated → which agent →
  which tool → what data), audit trails, verified/attested outcomes, and
  permission-scoped graph retrieval.
- Reseller ergonomics: anything that makes it easier for a customer to package,
  govern, meter, and bill *their* agents to *their* customers.
- External-agent governance: Oxagen governs ANY agent, first- or third-party
  (ADR-040). Work on the run-evidence ingress (`runner_observed` and
  `client_attested` evidence), the governed tool gateway, third-party agent
  identity and registration, wrapper SDKs/shims that make external agents
  observable, permission-requesting, and CGP-conformant, and evidence
  exports for auditors advances the wedge directly.

## What is drift

- Building standalone eval tooling, connector breadth for its own sake, or framework
  mindshare plays **as the front line** (they are permitted as fast-follows once the
  wedge is won, and as thin layers in service of the wedge).
- Deepening the first-party in-process agent runtime as a product surface
  (ADR-040): Oxagen is the governance plane, not the agent. Engine work
  belongs behind the `execute-turn` seam or upstream in Stella; removing or
  extracting runtime code in service of the refocus is advancing, not drift.
- New capabilities or tool surfaces that bypass typed contracts, IAM/entitlement
  gates, or metering ("just this once" untyped/unmetered paths).
- Agent answers or UI surfaces that present ungrounded, citation-free output where
  graph grounding applies.
- Hard-coupling to a single model vendor or cloud (hard-coded model slugs, provider
  lock-in, features that only work on one cloud).
- Fan-out/orchestration that emits no lineage or cost accounting.
- Agent actions that break the accountability chain — no principal attribution, no
  audit record, or retrieval that ignores the caller's knowledge scope.
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
6. Does it strengthen or weaken the accountability chain — the binding of identity,
   knowledge scope, permitted action, commercial terms, verified outcome, and audit
   record into the enforced contract object? (advances / drifts)
7. Is it routine maintenance, fix, test, or tooling work? (neutral)
