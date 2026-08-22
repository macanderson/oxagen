/* Shared narration + demo script — single source of truth for the deck and script.html. */
window.OX_SCRIPT = [
  {
    title: "Title — Oxagen",
    say: "Thanks for making time. In the next ten minutes I want to show you a layer that sits under every AI agent you run and makes it accountable — governed, metered, and fully traceable. Then I'll drop out of the slides and show you the actual tool. Quick promise up front: you won't have to re-document your business or sit through anything painful. Let's go.",
  },
  {
    title: "The two burns",
    say: "I want to name why we're probably talking. Two things tend to happen before someone calls us. One: a consulting engagement that produced a deck and a POC, then left — nothing your team owns, nothing running in production. Two: a model bill nobody could explain — real spend, no accountability. Underneath both is the same gap: you're running agents you can't see, can't govern, and can't bill back. Pause here — let them nod. This is the moment they feel understood.",
  },
  {
    title: "Three unanswerables",
    say: "Every agent in your org raises three questions no coding tool answers. What did it actually do — the trace. What was it allowed to touch — the access. And why did it cost that — the cost. Claude Code, Cursor, Copilot make agents productive. None of them make agents accountable. That's a different layer, and it's the layer we build.",
  },
  {
    title: "Introducing Oxagen",
    say: "Oxagen is that layer: the metered, governed, graph-grounded control plane for agents. You point your agents at Oxagen instead of raw model keys. From that moment every action is identity-scoped, every tool call is typed and governed, every answer is grounded in your graph, and every token is metered and attributable. Nothing about how your teams work changes — everything about what you can see and control does. Think of it as the Stripe for agents.",
  },
  {
    title: "The sharp edge — context governance",
    say: "Before the feature grid, the one idea to hold onto. Your agents only know what they are allowed to know. Oxagen resolves every retrieval against the caller's contracted capabilities before a single node leaves the store. Not filtering after the fact, not prompt guardrails, authorization at the graph edge itself. Three consequences. An allowed node can never bridge into a denied subgraph. If a person can't see it, their agent can't see it, and a revocation in Okta shrinks the agent's world on its next query. And a prompt injection can't widen a typed contract, so the attack fires and retrieves nothing outside the caller's surface. Say it plainly: gateways govern the tool call, we govern what the model reads.",
  },
  {
    title: "Why only Oxagen",
    say: "This is the slide I'd screenshot. Three capability families — governance, graph grounding, and the metering-to-billing loop — and one product that ships all three. Coding-agent tools give you none of the governance or billing. Consultants give you a slide about it. We're the only player at the intersection: RBAC, SOC 2, typed contracts, code graph, knowledge-graph grounding, full audit export, metering-to-billing, per-turn budgets, and vendor-neutral BYOK. Let them read it for a beat.",
  },
  {
    title: "Under the hood",
    say: "Briefly, how. Four graphs and one engine. The ontology — a knowledge graph so agents answer from cited, time-aware facts, not guesses. The code graph — typed, so agents query it before editing instead of grepping blindly. The execution graph — every run captured as a span tree. And the agent engine plus fleet mode — one engine for chat, the API and fan-out, dispatching governed teams of sub-agents under hard caps. Key point: all of it runs on the same identity, metering and audit spine. Not bolted on.",
  },
  {
    title: "Governance you can prove",
    say: "Governance you can prove, not promise. Identity travels with the key — every capability is role-gated and tenant-isolated at the database. Tools are typed contracts, so a prompt injection can't invent or widen a tool. And this is new and it's the direct answer to the mystery bill: per-turn budgeting. A hard cap on the tool loop per round, plus fan-out limits — a dispatch over a hundred tasks or two hundred fifty descendants is rejected outright. The runaway overnight loop literally can't happen. And SOC 2 is derived from live signal with signed audit export — not a PDF.",
  },
  {
    title: "Metering → billing",
    say: "The unexplained bill, explained. Every token is observed at the control plane, attributed, and priced — broken down by model, by surface, and by workspace, with a daily time series. When a number spikes you see exactly which team and which agent caused it. And because agents resell downstream, the same loop bills your customers. Usage in, governed invoice out — on your own keys.",
  },
  {
    title: "Traceability & audit",
    say: "Full auditability. Open any run and it expands into a span tree — every step, every tool call with duration, tokens, cost and status, and every sub-agent as child lineage. Nothing runs off the record. Alongside it, a filterable audit log with signed, tamper-evident export and access reviews. When security asks what an agent could reach and what it touched, the answer is a query, not a fire drill.",
  },
  {
    title: "Enterprise fit",
    say: "Why this fits you specifically. It's vendor-neutral and BYOK — bring any model and your own keys; Oxagen governs and meters but never becomes the lock-in. It deploys into your governance and compounds — unlike a consulting engagement, it doesn't leave when the invoice is paid. And you don't have to re-document every process; the graph learns them from the work itself. You don't have to be in the demo or re-explain your business — the accountability shows up on its own.",
  },
  {
    title: "About Mac",
    say: "Thirty seconds on who's building this, because you're trusting a team as much as a product. I've built and scaled businesses across multiple countries with hundreds of staff — real operational complexity, not just code. Eight consecutive years on the Inc. 5000, which puts us in the Hall of Fame. I'm a U.S. patent holder. And I've been building AI agents since the term existed — from the first time someone coupled a model response to a function call. I speak on this regularly and I'm active in the inference community. I built Oxagen as the system I wished existed every time an agent did something no one could explain.",
  },
  {
    title: "DEMO — you are now leaving the deck",
    say: "Alright — enough slides. Let me show you the actual tool. I'm going to do three quick things that map exactly to the three questions from earlier. Follow the numbered steps below; the deck is no longer on screen, so this panel is your only guide. When I'm done I'll flip back to one final slide.",
    demo: [
      "SET UP (before you share): have a browser tab on app.oxagen.sh ready. Share ONLY the deck/browser window or a single tab — this presenter window stays private. Log in with a demo org that has some prior agent activity so the trace and usage screens aren't empty.",
      "DEMO 1 · GOVERNED ANSWERS — In the workspace, ask the agent: 'where do we enforce tenant isolation, and is it consistent?' with the read-only grant selected. Narrate: 'Notice the grant — this agent physically cannot edit or exfiltrate. Watch what it does first.'",
      "DEMO 1 (cont.) — Point out the agent querying the code graph BEFORE answering. Say: 'The exact symbol and call graph stays beside this checkout, so it follows the bytes this agent can actually see; Oxagen receives governed run evidence, not a bulk copy of the code graph.' Then mention:  --max-steps caps the tool loop per turn (default 256), and --permission-mode goes ask → accept-edits → bypass → readonly. 'Local execution is bounded here; enterprise access and shared context are governed by Oxagen's RBAC policy.'",
      "DEMO 2 · FLEET MODE — Open Agents in the workspace and type a goal like 'add rate-limit tests across the API routes'. Let the planner produce multiple tasks. Say: 'When a turn needs more than one task, Oxagen fans out a governed team — each sub-agent in its own isolated worktree, merged back, with full lineage.'",
      "DEMO 2 (cont.) — Point at the Agent Team panel / task checklist as children run. Emphasize the guardrail: 'This fan-out is capped — 100 tasks per dispatch, depth 3, 250 total descendants. Exceed it and the dispatch is rejected. This is the per-turn budgeting that makes the mystery overnight bill structurally impossible.'",
      "DEMO 3 · TRACE — Switch to the browser: app.oxagen.sh → open a workspace → Activity. Open one recent execution. Say: 'Here's that run as a span tree — every step, every tool call with duration, tokens, cost and status, and every sub-agent as child lineage. Nothing ran off the record.' (API parity: the same span tree is available over /v1.)",
      "DEMO 3 · BILL — Navigate to Billing → Usage (/[org]/billing/usage). Say: 'This is the bill, explained. Total cost, tokens, cached tokens — then broken down by model, by surface, and by workspace, with a daily series. If a number spikes, I click straight to the team and the agent that caused it. No more unexplained invoice.'",
      "DEMO 3 · AUDIT — Navigate to Security → Compliance, then Security → Audit. Say: 'SOC 2 controls derived from live signal — not a static doc. And the audit log exports as signed NDJSON/CSV for your GRC team. Who did what, when, and why — for every agent action, tenant-isolated.'",
      "CLOSE THE DEMO — 'Three questions from the start of this call: what did it do, what could it touch, why did it cost that. You just watched all three answered — on your own model keys, inside your own governance.' Then flip BACK to the deck (Alt/Cmd-Tab to the deck window) and press → to land on the Thank You slide.",
    ],
  },
  {
    title: "Thank you / contact",
    say: "That's Oxagen — governed, metered, graph-grounded agents on your keys and in your governance. I'd love to scope a small pilot: one team, one runaway workflow, and we prove the bill and the trace in a week. What would you want us to answer first? Contacts are on screen — app.oxagen.sh, docs.oxagen.sh, and mac@oxagen.ai. Then open it up for questions.",
  },
];
