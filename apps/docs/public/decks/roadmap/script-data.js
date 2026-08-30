/* Shared narration · single source of truth for the roadmap deck presenter. */
window.OX_SCRIPT = [
  {
    title: "Title · Roadmap",
    say: "This is the roadmap. One thing to hold onto before the detail: Oxagen builds along a single line, not a feature sprawl. Make every agent governed, grounded, and metered. I have grouped the work by the five pillars we actually decide with. Anything labeled Now is shipped and running. Everything past Now is directional, dated by intent, not a commitment.",
  },
  {
    title: "How we choose what to build",
    say: "First, how we say no. A feature earns a slot only if it deepens one of five things: metering into billing, contract governance, graph grounding, vendor neutrality, or fleet lineage. Connector breadth, standalone evals, framework mindshare, those are fast-follows, never the lead. And this is enforced, not a slogan. A vision gate in CI reads every change and flags drift from the wedge.",
  },
  {
    title: "Now · shipped and running",
    say: "Start with what is already live, because the roadmap sits on a real spine. Typed contracts with RBAC and database-level tenant isolation. Two graphs: the ontology and an AST code graph agents query before they edit. The full metering loop, ClickHouse to Stripe, with per-turn budgets. One agent engine for chat, CLI, and fleet fan-out. Span-tree traces with signed audit export. Evals, an A2A surface, and bi-temporal facts. This is not a promise slide.",
  },
  {
    title: "Next · in flight this cycle",
    say: "Here is the headline move. We are pushing authorization out of the application layer and into the graph traversal itself. Node and edge ACLs compiled from repo, team, and tenant boundaries, so an allowed node can never bridge into a denied subgraph. Parity reports that diff an agent's surface against its principal, targeting zero. Live IdP sync so a revocation shrinks the agent's world on its next query. Plus full BYOK breadth and org-wide MFA and SSO enforcement.",
  },
  {
    title: "Later · directional",
    say: "The horizon turns the plane into the standard. One-click evidence packs mapped to SOC 2, ISO 42001, and the EU AI Act. A two-sided marketplace where partners publish capability packs that install under RBAC. Deny with reason, so a prompt injection retrieves nothing outside the caller's surface, which is how we intend to make injection inert at the knowledge layer. And the metering loop as a settlement layer for agents that bill agents. Directional on purpose, sequenced after the wedge is won.",
  },
  {
    title: "The same roadmap, by pillar",
    say: "If you prefer it as a grid, here is the same plan cut by pillar. The point of this view is that no pillar sits still. Context governance, graph grounding, metering, neutrality, and fleet lineage each move every cycle, from Now through Next to Later. We do not let one advance while the others rot.",
  },
  {
    title: "The through-line",
    say: "The close is one sentence. Every release makes an agent more accountable. Governed, grounded, and metered is not three products, it is one plane that gets deeper and harder to leave with every customer and every merge. That is the roadmap, and it is also the moat.",
  },
];
