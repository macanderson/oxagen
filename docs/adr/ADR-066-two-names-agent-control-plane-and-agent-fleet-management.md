# ADR-066: Oxagen has two names, the agent control plane and agent fleet management, and the agent asks for the keys

- **Status:** Accepted; the two names are superseded by ADR-067, the access rule stands
- **Date:** 2026-09-15
- **Owners:** Mac (positioning), platform
- **Related:** `docs/VISION.md`, ADR-043 (Oxagen governs agents, it does not run
  them), ADR-052 (the governed action is the billable unit), PR #3018 (the
  September positioning), PR #3075 (this decision lands in the branding skill),
  `oxagenai/oxagen-brand` `skills/oxagen-branding/` (the copy every agent reads),
  `packages/rules` (decision rules: allow, deny, require approval)

## Context

Positioning moved twice in two days. Until 2026-09-14 the brand led with the
definition of done: the agent does not get to decide it is done, and Oxagen
proves the result. Mac rejected that as the headline because it describes one
mechanism, not the business. PR #3018 replaced it with the control plane: every
agent runs under a mandate whose four clauses (access, budget and rules,
equipment, record) are set by security, FinOps and engineering and enforced on
every run.

"Control plane" is right and it is also an analogy. It is what Oxagen is to the
enterprise, and it reads as infrastructure. It does not say what a person does
with the product all day, and it sits close to the two categories the market
already has names for: observability, which watches an agent and reports, and
governance, which decides what an agent may not do. Both of those are owned by
other vendors, and neither operates anything. A control plane that only sets
terms is easy to mistake for a governance play with a better diagram.

The product already has the second name inside it. The Fleet page shows every
agent the organization runs; the skill's vocabulary defines the operator as
the human accountable for a run; ADR-043 says Oxagen never runs the agent, the
way a fleet manager never drives the trucks. Spend, which the market treats as
a separate FinOps product, sits beside the agent in Oxagen because the meter
prices the governed action (ADR-052), so the operator and the finance lead read
the same rows.

A second decision arrived with the first. The access clause needed a rule for
how copy talks about credentials. Every other tool assumes a service account:
the agent is handed a token with everything it might ever need. Oxagen's model
is a request: the agent holds an identity and a mandate, asks for a system,
scope or action at the moment of use, and a decision rule answers. The rules
package has exactly three effects, `allow`, `deny` and `require_approval`,
checked after identity and entitlement and before the handler, and
approval-gated contracts pause the run for a named person. Copy that says
"connect your agent to GitHub" describes the service-account model even when
the product does not have one.

## Decision

**Oxagen has two names and owns both.** It is the platform that governs and
operates the autonomous agents an enterprise runs.

- **The agent control plane** is what Oxagen is to the enterprise: the one
  place the terms are set for every agent it runs, whoever built the agent, and
  enforced on every call. Use it when the reader is deciding whether to adopt.
- **Agent fleet management** is what an operator does with Oxagen: see every
  agent that is running and under which mandate, see what each has asked for,
  spent and done, then answer its requests, fund it, hold it or stop it. Use it
  when the reader will sit at the console. **Spend management is part of fleet
  management**, not a separate product or a separate page.

Both names may appear in one paragraph. Neither replaces the mandate: the four
clauses and the three accountable teams are unchanged, and the five platform
jobs (govern, ground, explain, meter, rate) still decide what may be built.
Fleet management is the name that separates Oxagen from observe plays (they
watch) and pure governance plays (they say no): it operates, and operating is
metered.

**The agent asks for the keys.** Copy never describes an agent that holds a
key, a token or a standing grant. It requests at the moment of use; a rule the
owning team wrote answers allow, deny, or route to a named person; the answer,
the rule and the person are in the record. "Autonomous" is a plain description
of the agents being managed, never a compliment paid to Oxagen.

## Consequences

- `docs/VISION.md` names both categories under *Positioning* and adds a drift
  test: work that lets an operator see or act on the fleet as one population,
  including its spend, advances; work that only watches or only forbids does
  not distinguish us.
- `CLAUDE.md` *Mission* carries the two names so every session writes the same
  words.
- The branding skill is authored in `oxagenai/oxagen-brand`
  (`skills/oxagen-branding/`) and vendored into this repo by
  `tools/scripts/sync-brand-assets.mjs`. It carries the two names, the fleet
  and spend vocabulary, the access rule as rule six of the never-bend list,
  two new lead lines ("Don't hand your agents the keys." for the security
  reader and "Run your agents as a fleet." for the operator), worked examples
  and UI strings. The kit gains ads and content cards for both lines.
- Feature recommendations weigh the fleet: a Fleet page that shows mandate,
  open requests, spend against budget and last run per agent is the operator's
  surface, and the request-and-answer flow (`packages/rules`, the approval
  contracts, the Access page) is the mechanism behind the access rule.
- `apps/web` and the blog still carry the pre-September copy; rewriting them is
  a separate outward-facing PR.

## Alternatives considered

- **Fleet management alone.** More concrete, but it reads smaller to the
  platform buyer and drops the word the security and finance leads use to
  describe where policy lives. Rejected.
- **Control plane alone.** The state before this ADR. Too close to governance
  and observability from the outside, and silent about the operator. Rejected.
- **A third, coined category.** Every coined name has to be taught; both of
  these are pictures the reader already has. Rejected.
