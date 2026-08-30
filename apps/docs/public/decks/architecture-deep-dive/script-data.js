/* Presenter script for the Oxagen architecture deep-dive deck.
 * Consumed by the deck engine's teleprompter (press S). One entry per slide,
 * in slide order. `say` is the spoken line; `demo` is an optional step list. */
window.OX_SCRIPT = [
  {
    title: "Architecture deep dive — title",
    say: "This is the engineer's tour, not the pitch. You've seen what Oxagen does — now I'll show you how it's built, because for your security team the how is the whole decision. Four things: contracts, crypto, tenancy, and metering. Everything else hangs off those.",
  },
  {
    title: "What you're actually buying",
    say: "You're about to run hundreds of agents across vendors, touching production. The board wants the leverage; your job is to make it provable. Four questions gate every deployment in security review — prove control, custody, spend, and compliance. The rest of this deck is how each is enforced in code, not in a policy PDF.",
  },
  {
    title: "Architecture at a glance",
    say: "One idea to hold onto: every action is a capability contract, and nothing reaches a datastore except through invoke — which is where authorization, metering, and lineage get applied. Under it, four stores, each doing exactly one job. Analytics never touch the graph; graph edges never live in Postgres. That discipline is what makes the audit story clean.",
  },
  {
    title: "The capability contract — unit of governance",
    say: "Here's the heart of it. A capability isn't a route wired to a handler by hand. It's one typed object that declares its schema, which surfaces expose it, its default-deny policy, its role grants, its risk level, and its tenancy — all at once. Two hundred eighty-seven of these define the platform. This slide is the single most important one in the deck.",
  },
  {
    title: "Surface parity",
    say: "From that one declaration, the same capability becomes a REST route, an MCP tool, a CLI command, and an agent tool — same schema, same authorization, same meter. There is no second, weaker way in. That's why a prompt-injected agent can't invent an ungoverned action: the tool IS the contract. And check:manifest fails CI the instant a surface drifts. Parity is enforced, not hoped for.",
  },
  {
    title: "Governed by construction",
    say: "Every call routes through one choke point — invoke. Authorize, meter, trace, together. You can't accidentally ship a code path that skips the meter or the IAM check, because there's only one path. High-risk capabilities carry an approval gate the agent must clear first. And everything's cited by human label, never a raw UUID — an auditor reads names.",
  },
  {
    title: "Encryption at rest",
    say: "The question you asked directly: are we encrypted at rest? Yes. Dedicated crypto package — AES-256-GCM, a fresh 256-bit data key per write that's zeroed after use, wrapped by your KMS. AWS KMS adapter, or a local key for Vercel-native. And a Drizzle column type that makes encryption the default for sensitive fields. It's forbidden from logging plaintext. Not hand-rolled, not plaintext.",
  },
  {
    title: "BYOK / bring your own graph",
    say: "This is the trust moat. We're the governance and metering layer — not the model, not the lock-in. Your LLM keys, envelope-encrypted per org. Any provider through the gateway with zero data retention, no hard-coded slugs. And bring your own graph — your Neo4j, your connectors. You never have to trust us with the thing you can't afford to lose.",
  },
  {
    title: "SOC 2 & tenant isolation",
    say: "Isolation lives in the database, not the app. Raw db calls are banned; every query runs through a tenant-scoped session under a non-superuser role with FORCE RLS — so an application bug can't leak across tenants. RBAC from the contracts, immutable audit history, MFA and session review. And note the honesty: where org-wide MFA enforcement isn't finished, the dashboard says so. Auditors reward that.",
  },
  {
    title: "Observability",
    say: "Agents are non-deterministic; observability can't be. Every turn emits a structured event to an append-only store — tokens, tool calls, latencies, errors. OTLP export ships spans straight into Datadog or Grafana, wherever your SOC already watches. The Activity view renders each run as a span tree. And because the full turn is captured, you can replay it — exactly what it did and why.",
  },
  {
    title: "Metering → billing",
    say: "The same events that power observability power billing. Nothing's estimated — the meter reads what actually ran and reconciles to Stripe. Attributed per org, workspace, and agent. Per-turn USD budgets in three modes — grace, prompt, enforce — so runaway spend stops at the budget. And if you resell agents, usage flows to your customer's invoice. That loop is why we call it the Stripe for agents.",
  },
  {
    title: "Graph grounding",
    say: "RAG over a pile of chunks is a guess. We ground answers in a Neo4j graph with a real ontology — every claim traceable to the node behind it. Bi-temporal: facts carry valid-time and transaction-time, so you can ask what was true, and what was known, on any date. When an agent answers, the grounding is a graph path a human can audit. That's correctness you can point at.",
  },
  {
    title: "Plugins, skills & extensions",
    say: "The core is a spine of contracts; everything else is a plugin — a capability pack with a manifest, a tier, and an entitlement gate. Nothing runs that a workspace hasn't installed and paid for. Connectors are plugins too, dual-writing Postgres and the graph. Skills package the domain know-how the agent consults before acting. A capability becomes a product the moment it's a plugin — no change to the core.",
  },
  {
    title: "The CLI",
    say: "The CLI isn't a thin wrapper — it's a first-class governed surface. Same contract, same invoke, same meter as the API, in your engineers' hands. Solve and code for agentic coding, the graph commands, trace and replay and cost, encrypted secrets, sandboxes. And BYOK works here too — point it at your own key and it runs local, same governance, on your infrastructure.",
  },
  {
    title: "Agentic coding, step by step",
    say: "Walk them through a real coding turn. Step one, plan — decompose the goal, fan out sub-tasks each with their own budget. Step two, ground — query the code graph to find the real call sites and blast radius before editing. Step three, edit — in a sandbox, with high-risk actions hitting the approval gate. Step four, verify — run the narrow tests, read the result, iterate. The whole turn is traced, replayable, and billed.",
  },
  {
    title: "The moat matrix",
    say: "Step back. Contracts give you control. Crypto and BYOK give you trust. The graph gives you accuracy. Metering gives you revenue. None of these is a bolt-on — each is load-bearing for the next, and a point tool can't assemble the set after the fact. Connector breadth and standalone evals are fast-follows. This intersection is the wedge, and it's already wired.",
  },
  {
    title: "The close",
    say: "Here's the ask. Standardize agents on a plane that lets you prove control, spend, and compliance — across every vendor, down to the turn — without handing anyone the keys, the models, or the graph. Bring me one high-value workflow and your own keys. We'll stand it up governed, metered, and grounded, and hand your security team the audit trail before it touches production.",
    demo: [
      "PILOT ASK — one high-value agent workflow, customer's own keys, governed + metered from day one.",
      "Offer to run the security team through the RLS + crypto + audit surfaces directly.",
      "Leave-behind: this deck as PDF (Cmd/Ctrl+P) and a scoped pilot one-pager.",
    ],
  },
];
