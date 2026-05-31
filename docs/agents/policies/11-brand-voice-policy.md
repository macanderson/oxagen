# 11. Brand Voice Policy

Applies to all customer-facing and public content: the marketing site, landing pages, emails, social copy, in-product strings, release notes, and user docs. It does not govern internal code comments, SPECs, or team docs.

> **Source of truth for tone and visual identity:** the `oxagen-brand` skill. Where this section's tone, voice, or styling guidance diverges from that skill, the skill wins. The confidentiality rules in 11.1 are authoritative here and override nothing in the skill; they are an additional constraint the skill does not cover.

### 11.1 Confidentiality in Public Content

These never appear in anything a customer can read:

- Internal architectural decisions, the reasoning behind them, or the alternatives we rejected.
- Future releases, roadmap items, or anything not yet shipped. Do not promise, hint at, or tease unreleased capability.
- Internal system identifiers: Linear issue IDs, PR numbers, ticket references, branch names, service or package names, internal codenames, environment names.
- Internal jargon, team names, or process language that only an engineer or internal supporter would parse.
- Anything that would only make sense to someone who has seen the codebase.

The test: if a sentence requires insider context to understand or exposes how the sausage is made, it does not ship to customers.

### 11.2 Voice

- Consistent across every surface. One brand speaks, not many.
- Active voice, present tense, intent first, no fluff. (This matches the house writing style.)
- Confident and plain, never overly technical for the surface it lives on. Lead with clarity over cleverness.
- Human, not robotic. Write the way a sharp person explains something to a smart colleague, not the way a spec sheet reads.

### 11.3 Two Audiences, Two Registers

We write for two readers and pitch each correctly:

- **The buyer (CEO / CIO):** speaks the language of business outcomes, risk, cost, and reliability. Content for this reader focuses on the problem solved and the value delivered, not the mechanism.
- **The practitioner (engineering manager / engineer):** the person who actually uses the product. This reader earns technical depth, but in the docs, not the marketing site.

### 11.4 Marketing Site: Problems, Not Mechanisms

- The marketing site is for non-technical readers and people new to AI agents. Assume the reader does not know what an AI agent is, and build up from there.
- Never assume a reader knows a technical term. Do not use "multi-hop," "graph database," "ontology," "RAG," "vector store," "knowledge graph," or similar without plain-language framing, and prefer to avoid the jargon entirely in favor of the outcome it produces.
- Focus on the problems we solve and the outcomes we deliver, not how we solve them. The reader should leave understanding what gets better for them, not our internal design.
- Explain in terms of the reader's world: what was hard, what is now easy, what risk is now handled.

### 11.5 User Docs: Earn the Technical Credibility

- The user docs are where robustness, capability, and technical depth live. Speak to the engineer here at full fidelity.
- Be precise and technically honest. Name the real mechanisms, the real guarantees, the real limits. This is where we prove we are serious.
- Even here, keep the confidentiality rules of 11.1: document the shipped product and its public contract, never internal decisions, internal IDs, or unreleased work.
