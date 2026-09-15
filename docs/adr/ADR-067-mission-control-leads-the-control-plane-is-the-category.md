# ADR-067: Mission Control leads, the agent control plane is the category, and every claim states its scope

- **Status:** Accepted
- **Date:** 2026-09-15
- **Owners:** Mac (positioning), platform
- **Supersedes in part:** ADR-066 (the two names). ADR-066's access rule, that
  the agent asks for the keys and a rule answers, stands.
- **Related:** `docs/VISION.md`, ADR-043 (Oxagen governs agents, it does not
  run them), ADR-052 (the governed action is the billable unit), PR #3075 (the
  branding skill and ADR-066), `oxagenai/oxagen-brand` `messages/` (the message
  registry) and `skills/oxagen-branding/` (the copy every agent reads)

## Context

On 2026-09-15 an adversarial review of the launch messaging read the branding
skill, the message bank, the ad recipes and the playbook the way a skeptical
buyer would. It raised ten findings, five about claims a buyer could hold
Oxagen to and five about positioning and consistency.

The claim findings:

1. **Completion dominated the story.** "The agent doesn't get to decide it's
   done" describes bounded coding tasks. Operators also manage agents whose
   work has no finish line, and a passing verdict only establishes that the
   specified checks held.
2. **A lower bill was promised without a boundary.** "The next run costs less"
   is an outcome promise that cost attribution alone does not support.
3. **Enforcement was stated without its scope.** "Enforced on every call"
   hides unwrapped agents, observe mode, and workspaces with no rules, which
   the product itself distinguishes.
4. **Identity, credential custody and assurance were blurred.** The agent has
   its own identity; the connection credential Oxagen holds is a separate
   thing; "nothing for the agent to leak" overreaches; no SOC 2 report backs an
   attestation claim.
5. **Memory promised universal recall.** "Every agent you run has it"
   contradicts the mandate's scoped knowledge.

The positioning findings: the bill headline argued with providers instead of
showing attribution; the operator's full job (identity, authority, tools,
skills) was missing from the lead while two category names competed; sales copy
asserted a prospect's setup and printed traction numbers and buyer quotes
without dated evidence; the message bank had already drifted from the skill
and the ads; and the glossary asked a new reader to learn frames and witness
verdicts before understanding the product.

## Decision

**Mission Control is the experience. The agent control plane is the
category.** Oxagen is Mission Control for an autonomous agent workforce:
operators assign identities, set authority, equip agents with tools and
skills, and oversee their work through a shared control plane. The homepage
leads with "Mission Control for your autonomous agents." Fleet stays the name
of the operator's page and the vocabulary of the operator's job; it is no
longer a second category name. The mandate stays the unit, with identity made
explicit in the access clause.

**Completion is a control, not the definition.** The definition of done
applies to bounded tasks. Ongoing responsibilities are governed through
authority, budget and review points. A passing verdict means the specified
checks held, and the team decides whether those checks suffice. "Proven" is
used only beside a witness result and its scope. The dod lines stay held until
the dod ships and are never the lead.

**Every claim states its scope.**

- Enforcement applies to actions routed through Oxagen. Observe mode is
  recorded, not enforced. Detail pages name the supported integrations, the
  default when no rule matches, and outage behaviour.
- Each agent has its own identity. For mediated connections Oxagen uses the
  connection credential on the agent's behalf and the agent does not receive
  it. No leak promise.
- No SOC 2 statement appears unless it names the actual report type, entity,
  system scope and period.
- Cost copy claims visibility and attribution. Savings are stated only for a
  measured workload under stated conditions. No provider comparison.
- Knowledge copy promises the context a task requires, within the agent's
  permitted scope, never universal recall.
- Outreach asks a diagnostic question instead of asserting a prospect's setup.
  Buyer sentences are labelled hypothetical. Traction, partner counts and setup
  durations need dated evidence before publication.

**The message registry is the source of truth for copy.** Every approved line,
section, card, email and ad is one YAML entry in `oxagenai/oxagen-brand`
`messages/`, carrying its audience, release status, gate, qualifier, required
evidence, owner and review date. The message bank page, the JSON export and the
ad recipes are generated from it, and a check fails when a rendered ad maps to
no approved entry or when a retired line reappears. The branding skill carries
the positioning rules and lists the current lead lines inline so its vendored
copy works without the registry.

Retired: "Can you explain your AI bill? Neither can your provider.", "Stop
wasting money on AI.", "Never re-explain yourself to AI ever again.", "Agents
that prove their work. A model you own.", "Run your agents as a fleet.", and the
sublines "Oxagen learns from every run, and the next one costs less." and
"Teach Oxagen your business once. Every agent you run has it."

## Consequences

- `docs/VISION.md`, and the mission lines in `CLAUDE.md`, `AGENTS.md`,
  `README.md` and `CONTRIBUTING.md`, lead with Mission Control and the
  control plane and scope enforcement to actions routed through Oxagen.
- The vendored branding skill under `.claude/skills/oxagen-branding/` is
  re-synced from the kit by `tools/scripts/sync-brand-assets.mjs`.
- Launch acceptance, not copy, carries the evidence each claim needs: a
  walkthrough with an ongoing agent and a bounded task, allow, deny, approval,
  missing-rule, observe-mode and outage cases per integration, identity
  provisioning and revocation, a reconciled cost row, and scoped retrieval.
- Before launch the proposed copy gets a comprehension test with five to eight
  people in each priority buyer group, and any reading that implies universal
  correctness or universal agent coverage is revised.
- `apps/web` and the blog still carry older copy; their rewrite (PR #3087 is
  moving the site onto the message bank) must read from the registry.

## Alternatives considered

- **Keep both category names (ADR-066).** The review found two competing
  category claims pulled attention from the operator's job. Rejected; fleet
  remains as product vocabulary.
- **Lead with the definition of done.** Accurate for bounded coding tasks,
  narrow for the workforce the product manages, and it invites a broad
  correctness reading. Rejected as the lead; kept as a held control.
- **Lead with the bill.** Cost attribution is a strong finance entry point and
  a weak description of the whole product. Kept as the finance entry point.
