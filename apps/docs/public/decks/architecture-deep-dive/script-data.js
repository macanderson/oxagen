/* Presenter script for the Oxagen architecture deep-dive deck.
 * Consumed by the deck engine's teleprompter (press S). One entry per slide,
 * in slide order. `say` is the spoken line; `demo` is an optional step list. */
window.OX_SCRIPT = [
  {
    title: "Architecture deep dive · title",
    say: "This is the engineer's tour, not the pitch. You've seen what Oxagen does. Now I'll show you how it's built, because for your security team the how is the whole decision. Four things: contracts, crypto, tenancy, and metering. Everything else hangs off those.",
  },
  {
    title: "What you're actually buying",
    say: "You're about to run hundreds of agents across vendors, touching production. The board wants the output, and your job is to make it provable. Four questions gate every deployment in security review: control, custody, spend, and compliance. The rest of this deck shows how each one is enforced in code, not in a policy PDF.",
  },
  {
    title: "Architecture at a glance",
    say: "One idea to hold onto. Every action is a capability contract, and nothing reaches a datastore except through invoke, which is where authorization, metering, and lineage get applied. Under it sit four stores, each doing exactly one job. Analytics never touch the graph. Graph edges never live in Postgres. That discipline is what keeps the audit story clean.",
  },
  {
    title: "The capability contract · unit of governance",
    say: "Here's the heart of it. A capability isn't a route wired to a handler by hand. It's one typed object that declares its schema, which surfaces expose it, its default-deny rule, its role grants, its risk level, and its tenancy, all at once. Two hundred eighty-seven of these define the platform. This is the most important slide in the deck.",
  },
  {
    title: "Surface parity",
    say: "From that one declaration, the same capability becomes a REST route, an MCP tool, a CLI command, and an agent tool. Same schema, same authorization, same meter. There is no second, weaker way in. That's why a prompt-injected agent can't invent an ungoverned action: the tool is the contract. And check:manifest fails CI the instant a surface drifts. Parity is enforced, not hoped for.",
  },
  {
    title: "Governed by construction",
    say: "Every call routes through one choke point, invoke. Authorize, meter, and record, together. You can't ship a code path that skips the meter or the IAM check, because there's only one path. A high-risk capability is routed to a person first, and the run waits for the answer. And everything is cited by human label, never a raw UUID. An auditor reads names.",
  },
  {
    title: "Encryption at rest",
    say: "The question you asked directly: is it encrypted at rest? Yes. A dedicated crypto package, AES-256-GCM, with a fresh 256-bit data key per write that's zeroed after use and wrapped by your KMS. An AWS KMS adapter, or a local key for Vercel-native deployments. And a Drizzle column type that makes encryption the default for sensitive fields. It's forbidden from logging plaintext, and the agent never sees a credential.",
  },
  {
    title: "BYOK and bring your own graph",
    say: "This is the trust moat. Oxagen sets and meters the terms. It is not the model and it is not the lock-in. Your LLM keys, envelope-encrypted per org. Any provider through the gateway with zero data retention, and no hard-coded slugs. And bring your own graph: your Neo4j, your connectors. You never have to hand Oxagen the thing you can't afford to lose.",
  },
  {
    title: "SOC 2 and tenant isolation",
    say: "Isolation lives in the database, not the app. Raw db calls are banned. Every query runs through a tenant-scoped connection under a non-superuser role with FORCE RLS, so an application bug can't leak across tenants. Roles from the contracts, immutable audit history, MFA, and sign-in and device review. And note the honesty: where org-wide MFA enforcement isn't finished, the dashboard says so. Auditors reward that.",
  },
  {
    title: "The record",
    say: "Agents are non-deterministic. The record of what they did is not. Every turn emits a structured event to an append-only store: tokens, tool calls, latencies, errors. OTLP export sends it to whatever backend your SOC already watches. The Activity view renders each run as a tree of steps. And because the full turn is captured, you can replay it and see exactly what it did and why.",
  },
  {
    title: "Metering to billing",
    say: "The events that make up the record also make up the bill. Nothing is estimated. The meter reads what ran and reconciles to Stripe. Attributed per org, workspace, and agent. Per-turn USD budgets in three modes, grace, prompt, and enforce, so runaway spend stops at the budget. And every dollar lands against the team that spent it, so finance can charge it back without a spreadsheet.",
  },
  {
    title: "Graph grounding",
    say: "RAG over a pile of chunks is a guess. Oxagen grounds answers in a Neo4j graph with a real ontology, and every claim ties back to the node behind it. It's bi-temporal: facts carry valid time and transaction time, so you can ask what was true, and what was known, on any date. When an agent answers, the grounding is a graph path a human can audit. That's correctness you can point at.",
  },
  {
    title: "Plugins, skills, and extensions",
    say: "The core is a spine of contracts. Everything else is a plugin: a capability pack with a manifest, a tier, and an entitlement gate. Nothing runs that a workspace hasn't installed and paid for. Connectors are plugins too, dual-writing Postgres and the graph. Skills package the domain know-how the agent consults before acting. A capability becomes a product the moment it's a plugin, with no change to the core.",
  },
  {
    title: "The CLI",
    say: "The CLI isn't a thin wrapper. It's a governed surface in its own right. Same contract, same invoke, same meter as the API, in your engineers' hands. Solve and code for coding runs, the graph commands, replay and cost, encrypted secrets, and sandboxes. And BYOK works here too. Point it at your own provider key and it runs locally, under the same rules, on your infrastructure.",
  },
  {
    title: "A coding turn, step by step",
    say: "Walk them through a real coding turn. Step one, plan: decompose the goal and fan out sub-tasks, each with its own budget. Step two, ground: query the code graph to find the real call sites and blast radius before editing. Step three, edit: in a sandbox, with high-risk actions routed to a person. Step four, verify: run the narrow tests, read the result, iterate. The whole turn is recorded, replayable, and billed.",
  },
  {
    title: "The moat matrix",
    say: "Step back. Contracts give you control. Crypto and BYOK give you trust. The graph gives you accuracy. Metering gives you revenue. None of these is a bolt-on. Each is load-bearing for the next, and a point tool can't assemble the set after the fact. Connector breadth and standalone scoring are fast-follows. This intersection is the wedge, and it's already wired.",
  },
  {
    title: "The close",
    say: "Here's the ask. Standardize your agents on one control plane and run them as a fleet, across every vendor, down to the turn, without handing anyone the keys, the models, or the graph. Bring me one high-value workflow and your own keys. Oxagen stands it up governed, metered, and grounded, and your security team reads the record before it touches production.",
    demo: [
      "Pilot ask: one high-value agent workflow, the customer's own keys, governed and metered from day one.",
      "Offer to walk the security team through the RLS, crypto, and audit pages directly.",
      "Leave-behind: this deck as PDF (Cmd/Ctrl+P) and a scoped pilot one-pager.",
    ],
  },
];
