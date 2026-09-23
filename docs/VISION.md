# Oxagen Vision: workforce management for autonomous agents

> **Mission: Oxagen is workforce management for autonomous agents: give each agent
> an identity, set its authority and budget, equip it with tools and skills, and
> review what it did and what its operators spent, through a shared agent control
> plane. Every agent operates under a mandate set by the teams accountable for it
> and enforced on the actions routed through Oxagen. The workforce it governs is
> autonomous and supervised alike.**

We sell to the teams that answer for the agents: the security team that decides
what an agent may reach, the FinOps team that decides what it may spend and under
which business rules, and the engineering team that decides what it knows and what
it can do. Coding teams first, because everyone using a terminal agent today is a
customer. We do not sell to resellers, and we do not build the machinery a customer
would need to resell agent usage to their own customers.

This document is the north star for every product and engineering decision. Feature
recommendations, roadmap priorities, and architecture choices are judged against it —
by humans, by coding agents (see `CLAUDE.md` → *Mission*), and by the automated
Vision Gate in CI (`.github/workflows/vision-gate.yml`), which LLM-judges every PR
diff against this file and flags drift.

## What a control plane is

A control plane does not run the workload. It decides what the workload may do, hands
it what it needs, and keeps the record. Kubernetes does not execute your containers;
IAM does not run your services. Oxagen does not run agents (ADR-043) — Stella and any
other agent do the work. Oxagen is where the company sets the terms under which that
work is allowed to happen, and where it goes to find out what happened.

The unit the control plane manages is the **mandate**. Security, finance, and
engineering are not configuring three products; each writes one clause of the same
mandate, and the platform enforces the whole thing on every run:

| Clause | Who sets it | What it says | Platform job |
|---|---|---|---|
| **Access** | Security | Which identity the agent acts as, which systems it is connected to, which data and graph scope it may read, which actions it is permitted | **Govern** |
| **Budget & rules** | FinOps | What it may spend, under which commercial terms, and the business rules it must obey — approval thresholds, allowed vendors, decision rules | **Meter**, **Govern** |
| **Equipment** | Engineering | The knowledge it is handed at the start of a job, the skills and tools it may use, the steering it runs under | **Ground** |
| **Record** | The platform | What the run read, what it changed, what proved it, what it cost — one trace an auditor, a finance lead, or an engineer can read | **Explain**, **Rate** |

Five platform jobs enforce the four clauses — **govern, ground, explain, meter,
rate**. Every capability in the tree must serve one of them or be deleted.

## The gap — nobody enforces the mandate as one object

Despite the explosion of agent tooling, **90% of organizations have no way to govern
what agents in production are actually doing, and 54% have already had a security
incident caused by an agent acting unexpectedly.** The reason is structural — every
existing layer covers one clause and stops:

- **Identity** says *who the agent is* — and nothing more.
- **Gateways** say *which tools it can call* — but most only handle routing, some
  handle authentication, and very few handle the full accountability chain: who
  initiated the task, which agent acted, which tool was called, and what data was
  accessed.
- **Billing** says *what it consumed* — but can't stop anything.
- **Prompt and skill repos** say *what the agent was told* — with no link to what it
  was allowed to do or what it cost.

Nobody binds those into one enforced object. Oxagen's mechanism for doing so is the
**typed capability contract**: every capability carries the caller's identity, the
graph scope it may read, the action it is entitled to take (IAM + entitlements), the
commercial terms it is metered and billed under, the outcome it produced, and the
audit record it leaves behind — **identity → knowledge scope → permitted action →
commercial terms → outcome → audit record** — enforced at invocation time, not
reconstructed after the incident. The contract is how a mandate becomes executable.

Even the official MCP 2026 roadmap names audit trails, enterprise-managed auth, and
gateway patterns as open gaps: the protocol layer itself is asking for what Oxagen's
contract layer already is.

## Positioning

Oxagen does not compete where it loses. It will not out-Glean Glean on connector
breadth and graph maturity, out-eval Braintrust, or out-mindshare LangGraph. The
single wedge where a platform of Oxagen's exact shape can credibly be #1:

**Workforce management for every agent an enterprise runs, whoever built it, on an agent control plane.**

Workforce management is the product and the agent control plane is the category
(ADR-113, superseding the product name in ADR-067, which in turn superseded
ADR-066's two names). The operator's job is the lead: define an agent's identity and
authority, equip it with tools, skills and the business context its work requires,
and review what it does, whether the work is a bounded task or an ongoing
responsibility. The Fleet page is where the operator sees every agent as one
population, with its mandate, open requests, spend against budget and last run, and
answers, funds, holds or stops it. Two things separate us from the plays beside us.
The first: observability watches and reports, governance says no, and neither
operates anything, while every operator action here is a governed action the meter
prices. The second: they report on the agent, and Oxagen also reports on the person
who steered it. That is the operator review. As of 2026-09-19, none of the plays
named above ships one.

Every claim states its scope (ADR-067). Enforcement applies to actions routed through
Oxagen, and observe mode is recorded, not enforced. The tier ladder has four words,
computed from what was actually routed: observe, harness, gateway, contained
(ADR-095). A hook-tier control decides on governed calls: `PreToolUse` and Claude
Code's own permission-request event answer from the signed mandate offline, so a
tool the mandate denies is refused even with the daemon down. It stays
client-attested, because it runs inside a process Oxagen does not own and sees only
the calls the harness routes through it (a person can remove the hook entry,
disable hooks, or run another build of the harness, and none of that is visible to
Oxagen). It fails open exactly where the mandate names no rule for a tool,
deferring to the harness's own permission prompt rather than to a silent Oxagen
allow. Today agents sit on observe or harness; the gateway tier is in build
and the contained tier is not started. Completion checks are an optional
control for bounded tasks, and a passing verdict means the specified checks held.
Cost copy claims attribution, not savings, unless the workload was measured. The
approved copy lives in the message registry in `oxagenai/oxagen-brand` `messages/`.

Not "another agent framework" and not "another enterprise search box." The knowledge
graph is the **accuracy moat**, vendor-neutral BYOK (own model keys, own Neo4j
endpoint) is the **trust moat**, and the corpus of recorded, rated runs is the
**compounding asset** no competitor can copy from outside the customer: proven runs
leave behind skills, tools, tuned settings, and knowledge written back to the graph,
and later train an open-weight model the customer owns and can run inside their own
firewall. Labels are the expensive part of training a model; a run that fails a test
and then passes it is a label made as a side effect of doing the work.

## Market gaps we own (underserved needs nobody bundles)

1. **Per-run cost attribution an enterprise can act on.** The clearest whitespace.
   Observability tools show spend as a total; FinOps tools chargeback by account.
   Neither can say which agent, on whose behalf, under which rule, spent what. Oxagen
   meters the governed action, so the answer is a row, not an estimate. Verified:
   uncontested.
2. **Governed, schema-enforced, metered MCP tools as an anti-poisoning story.** The
   market fears tool poisoning/injection (OWASP entry, ~200K vulnerable instances),
   but gateways only inspect third-party servers. A platform whose tools are natively
   typed contracts with IAM + entitlement enforcement is a different, stronger trust
   posture. Underserved.
3. **The mandate enforced as one object.** Identity vendors, gateways, billing tools
   and prompt repos each cover one clause; none binds who initiated the task, which
   agent acted, which tool was called, what data was accessed, under what commercial
   terms, with what outcome and audit record — into one object enforced at
   invocation. Oxagen's typed contract *is* that object. Uncontested as a bundle.
4. **Graph-grounded accuracy/citations with time-aware fact validity.** Graphiti
   proved bi-temporal graphs improve reasoning accuracy, but as a thin-funded library.
   Nobody offers hosted, multi-tenant, citation-backed, time-aware graph grounding as
   a product. Real gap.
5. **Vendor-neutral agent platform (no cloud gravity).** Every full platform pulls
   toward a cloud (Azure/GCP) or a model (OpenAI/Anthropic/Cognition). A credibly
   neutral, BYOK, self-hostable-or-hosted platform is underserved — especially for
   teams burned by OpenAI's AgentKit deprecation and Microsoft's forced AutoGen/SK
   migration.
6. **Fleet-scale lineage + metering.** Everyone ships "parallel agents"; nobody
   records a fleet where each agent grounds in a shared typed graph and every step
   emits lineage + cost. Partially owned by no one — but requires proof to claim.

## Go-to-market tailwinds

- OpenAI killed its governance/eval layer (AgentKit shutdown Nov 30, 2026).
- Microsoft forced a painful AutoGen/Semantic Kernel migration.
- The market is actively cutting AI spend — metering and cost attribution are budget
  line items, not nice-to-haves.
- Tool-poisoning fear is driving demand for exactly the typed-contract governance
  Oxagen already enforces.

Win by being the one place an enterprise sets and enforces the mandate for every
agent it runs — then earn evals and connector breadth as **fast-follows, not the
front line**.

## What advances the vision

Work that lets an accountable team set a clause of the mandate, or lets the platform
enforce or record it:

- **The fleet (operators):** one population view of every agent the organization
  runs — mandate, open requests, spend against budget, last run — and the actions an
  operator takes on it (answer a routed request, fund, hold, stop), each a governed,
  metered action. Spend lives on the fleet page beside the agent (ADR-066, ADR-067).
- **The operator review (rate):** one page per person, read from the record and
  never estimated (ADR-113). It shows spend by operator, agent and workspace, the
  same rows the Spend page prices, cut by the person who started the run; outcome
  per dollar for bounded tasks; and prompt habits drawn from the recorded turns,
  meaning turns to completion, restarts on the same task, steering overridden by
  hand instead of written as a rule, and routed requests the operator approved every
  time. Each habit carries one recommendation, worded as a rule the operator can
  adopt. It reports what the record shows and never grades the person: no score, no
  ranking, no performance verdict.
- **The request, not the key (security):** an agent holds an identity and a mandate,
  never a standing credential; it asks at the moment of use and a decision rule
  answers allow, deny or route to a person (`packages/rules`, the approval contracts).

- **Access (security):** agent identity and registration, connections to systems,
  IAM + entitlement gates, permission-scoped graph retrieval, principal attribution
  (who initiated → which agent → which tool → what data), the governed tool gateway.
- **Budget & rules (FinOps):** metering coverage — every capability, agent step, and
  LLM call emits usage events that can be priced (`invoke()` metering, `@oxagen/ai`
  telemetry, Stripe meter sync); budgets and admission gates; decision rules and
  business mandates enforced in the kernel; cost attribution that resolves spend to a
  workspace, an agent, a rule, and a run.
- **Equipment (engineering):** graph grounding — agent answers cite nodes/edges with
  time-aware validity; ingestion and ontology work that deepens cited, multi-tenant
  grounding; skills, tools, steering and prompt settings managed as governed,
  versioned objects; what a proven run writes back into the graph.
- **Record (platform):** the evidence ledger and the tacho seam; run-evidence
  ingress (`runner_observed` and `client_attested` evidence); audit trails; evidence
  exports for auditors; rating on recorded outcomes rather than self-report; fleet
  lineage where every step emits typed lineage + cost.
- **Contract governance:** new capabilities land as typed contracts with IAM +
  entitlement gates and full API/MCP/CLI/UI parity; nothing ships as an ungoverned
  tool surface.
- **Vendor neutrality:** BYOK paths, model/provider abstraction (`modelIdOf()`, the AI
  Gateway), self-hostable surfaces, and zero hard vendor lock-in.
- **External-agent governance:** Oxagen governs ANY agent, first- or third-party
  (ADR-040, ADR-043). Wrapper SDKs/shims that make external agents observable,
  permission-requesting, and CGP-conformant advance the wedge directly.

## What is drift

- Building standalone eval tooling, connector breadth for its own sake, or framework
  mindshare plays **as the front line** (they are permitted as fast-follows once the
  wedge is won, and as thin layers in service of the wedge).
- Running agents. Any in-process agent runtime, sandbox, coding engine, worker,
  subagent fan-out, skill executor, eval harness, automation engine, browser/code
  tool, or content generator as a product surface (ADR-043): Oxagen is the control
  plane, not the agent. Engine work belongs in Stella; removing or extracting runtime
  code in service of the refocus is advancing, not drift. One distinction (ADR-096,
  amending ADR-043): Oxagen does not run turns, but it may contain the process that
  does. A launcher that confines a process is not an agent runtime, and neither is a
  loopback proxy that forwards a request a harness made (ADR-094). The
  contained tier (`oxagen run -- <agent>`, an OS sandbox whose only egress is the
  gateway) is that launcher, aimed at CI, headless runs, cloud runners and managed
  devices. Its first profile is a measured Docker container on Linux (ADR-152),
  and the control plane, not the launcher, decides that a run was contained.
- New capabilities or tool surfaces that bypass typed contracts, IAM/entitlement
  gates, or metering ("just this once" untyped/unmetered paths).
- Agent answers or UI surfaces that present ungrounded, citation-free output where
  graph grounding applies.
- Hard-coupling to a single model vendor or cloud (hard-coded model slugs, provider
  lock-in, features that only work on one cloud).
- Fan-out/orchestration that emits no lineage or cost accounting.
- Agent actions that break the mandate — no principal attribution, no audit record,
  or retrieval that ignores the caller's knowledge scope.
- Storing data across the four-store boundaries in ways that break the metering or
  grounding story (see `CLAUDE.md` → *Infrastructure boundaries*).
- Reseller and re-bill machinery: letting a customer package, price, and invoice
  agent usage to *their* customers — downstream customer records, markup or per-unit
  price plans, usage attribution to a third party, re-bill runs, or holding a
  customer's own payment credentials so we can bill on their behalf. We sell the
  platform by use, fine-tuning runs at a flat fee, and hosting at cost. There is no
  margin line, so there is nothing to resell.

**Not drift:** bug fixes, refactors, tests, CI/tooling, docs, dependency hygiene,
performance work, and maintenance of existing surfaces. Routine engineering that
keeps the platform healthy is neutral by definition — the gate exists to catch
strategic drift, not to nag maintenance.

## Drift tests (the questions the Vision Gate asks)

1. Does this change let an accountable team set a clause of an agent's mandate —
   grant access, bound spend and rules, equip it with knowledge, skills or tools —
   or let the platform enforce that mandate or record what happened under it?
   (advances)
2. Does it add a capability without a typed contract, IAM/entitlement gate, or
   metering? (drifts)
3. Does it present agent output without citations where graph grounding applies?
   (drifts)
4. Does it couple the platform to one vendor/cloud where a neutral abstraction
   exists? (drifts)
5. Is it front-line investment in a market we explicitly declined to fight
   (connector breadth, standalone evals, framework mindshare)? (drifts)
6. Does it make Oxagen run agents rather than govern them — an engine, a sandbox
   for Oxagen's own agent code, fan-out, or an executor as a product surface?
   (drifts) Containing a customer's agent process, or proxying its model traffic on
   loopback, is governing, not running (ADR-094, ADR-096).
7. Does it strengthen or weaken the enforced contract — the binding of identity,
   knowledge scope, permitted action, commercial terms, outcome, and audit record
   into one object? (advances / drifts)
8. Does it build machinery for a customer to resell agent usage to their own
   customers — markup pricing, downstream customer records, re-bill runs, or holding
   their payment credentials? (drifts)
9. Is it routine maintenance, fix, test, or tooling work? (neutral)
10. Does it let an operator see or act on the fleet as one population, including its
    spend, or move a credential out of the agent's hands into a request a rule
    answers? (advances) Does it hand an agent a standing credential, or add a
    watch-only or forbid-only surface that no operator can act from? (drifts)
11. Does it show an operator, from the record, what their own steering cost and what
    it bought, without grading the person? (advances) Does it score, rank or issue a
    performance verdict on a person? (drifts)
