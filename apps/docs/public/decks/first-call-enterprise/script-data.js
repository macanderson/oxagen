/* Shared narration + demo script — single source of truth for the deck and script.html. */
window.OX_SCRIPT = [
  {
    title: "Historical: Title: Oxagen",
    say: "Historical presentation. Product, pricing, and security claims may be obsolete. Use the current docs for setup and supported features. Thanks for making time. Workforce management for autonomous agents: see which agent spent what, and on whose behalf. In the next ten minutes I want to show you the layer that gives you that for every agent you run: every agent under a mandate, every call priced and attributed, every run on the record. Then I'll drop out of the slides and show you the actual tool. One promise up front: you won't have to re-document your business or sit through anything painful.",
  },
  {
    title: "Historical: The two burns",
    say: "I want to name why this call is probably happening. Two things tend to come before it. One: a consulting engagement that produced a deck and a proof of concept, then left. Nothing your team owns, nothing running in production. Two: a model bill nobody could explain. Real spend, no accountability. Underneath both is the same gap. You run agents you can't see, can't govern, and can't bill back. Pause here and let them nod. This is the moment they feel understood.",
  },
  {
    title: "Historical: Three unanswerables",
    say: "Every agent in your org raises three questions no coding tool answers. What did it actually do: the record. What was it allowed to touch: the access. And why did it cost that: the cost. Coding agents make your team productive. None of them make agents accountable. That is a different layer, and it is the layer Oxagen builds.",
  },
  {
    title: "Historical: Introducing Oxagen",
    say: "Oxagen is that layer: the agent control plane for every agent you run. You point your agents at Oxagen instead of handing them raw keys. From then on every action carries an identity, every tool call is a governed action a rule answers, every answer is grounded in your graph, and every token is priced and attributed. How your teams work does not change. What you can see and decide does.",
  },
  {
    title: "Historical: The sharp edge: context governance",
    say: "Before the feature grid, the one idea to hold onto. Your agents only know what they are allowed to know. Oxagen resolves every retrieval against the caller's contracted capabilities before a single node leaves the store. Not filtering after the fact, not instructions in the prompt, authorization at the graph edge itself. Three consequences. An allowed node can never bridge into a denied subgraph. If a person can't see it, their agent can't see it, and a revocation in Okta shrinks the agent's world on its next query. And a prompt injection can't widen a typed contract, so the attack fires and retrieves nothing outside the caller's surface. Say it plainly: gateways govern the tool call, Oxagen governs what the model reads.",
  },
  {
    title: "Historical: Why only Oxagen",
    say: "This is the slide I'd screenshot. Three capability families, access rules, graph grounding, and the metering to billing loop, and one product that ships all three. Coding-agent tools give you none of the rules or billing. Consultants give you a slide about it. Oxagen is the only player at the intersection: RBAC, SOC 2, typed contracts, code graph, knowledge-graph grounding, full audit export, metering to billing, per-turn budgets, and vendor-neutral BYOK. Let them read it for a beat.",
  },
  {
    title: "Historical: Under the hood",
    say: "Briefly, how. Four graphs and one engine. The ontology, a knowledge graph, so agents answer from cited, time-aware facts, not guesses. The code graph, typed, so agents query it before editing instead of grepping blindly. The run record, every run kept as a tree of turns and steps. And the agent engine plus fleet mode, one engine for chat, the CLI, and fan-out, dispatching governed sub-agents under hard caps. Key point: all of it sits on the same identity, metering, and audit spine. Nothing is bolted on.",
  },
  {
    title: "Historical: Access",
    say: "Don't hand your agents the keys. Identity travels with every request, and every capability is role-gated and tenant-isolated at the database. The agent asks for what the task needs, when it needs it, and a rule answers. Tools are typed contracts, so a prompt injection can't invent or widen a tool. And this is the direct answer to the mystery bill: per-turn budgeting. A hard cap on the tool loop per turn, plus fan-out limits. A dispatch over a hundred tasks or two hundred fifty descendants is denied outright, so the runaway overnight loop stops at the cap. And SOC 2 is derived from live signal with signed audit export, not a PDF.",
  },
  {
    title: "Historical: Metering → billing",
    say: "The unexplained bill, explained. Every governed action is priced at the control plane and attributed, broken down by model, by surface, and by workspace, with a daily time series. When a number spikes you see which team and which agent caused it, and the same loop charges it back to them. Usage in, an invoice you can explain out, on your own keys.",
  },
  {
    title: "Historical: Record and audit",
    say: "Full auditability. Open any run and it expands step by step: every tool call with duration, tokens, cost, and status, and every sub-agent as child lineage. Nothing runs off the record. Alongside it, a filterable audit log with signed, tamper-evident export and access reviews. When security asks what an agent could reach and what it touched, the answer is a query, not a fire drill.",
  },
  {
    title: "Historical: Enterprise fit",
    say: "Why this fits you specifically. It is vendor-neutral and BYOK. Bring any model and your own keys. Oxagen governs and meters but never becomes the lock-in. It works inside your controls and compounds. Unlike a consulting engagement, it does not leave when the invoice is paid. And you don't have to re-document every process, because the graph learns them from the work itself. You don't have to be in the demo or re-explain your business. The accountability shows up on its own.",
  },
  {
    title: "Historical: About Mac",
    say: "Thirty seconds on who's building this, because you're trusting a founder as much as a product. I've built and scaled businesses across multiple countries with hundreds of staff: real operational complexity, not just code. Eight consecutive years on the Inc. 5000, which puts those businesses in the Hall of Fame. I'm a U.S. patent holder. And I've been building AI agents since the term existed, from the first time someone coupled a model response to a function call. I speak on this regularly and I'm active in the inference community. I built Oxagen as the system I wished existed every time an agent did something no one could explain.",
  },
  {
    title: "Historical: DEMO: you are now leaving the deck",
    say: "All right, enough slides. Let me show you the actual tool. I'm going to do three quick things that map exactly to the three questions from earlier. Follow the numbered steps below. The deck is no longer on screen, so this panel is your only guide. When I'm done I'll flip back to one final slide.",
    demo: [
      "SET UP (before you share): have a terminal and a browser tab on app.oxagen.sh both ready. Share ONLY the deck or browser window, or a single tab. This presenter window stays private. Log in with a demo org that has some prior agent runs so the run and usage screens aren't empty.",
      "DEMO 1 · GOVERNED CLI: In the terminal, run:  oxagen --permission-mode readonly \"where do we enforce tenant isolation, and is it consistent?\"  Narrate: 'Notice it's read-only. This agent cannot edit or exfiltrate. Watch what it does first.'",
      "DEMO 1 (cont.): Point out the agent calling its local code_graph tool BEFORE answering. Say: 'The exact symbol and call graph stays beside this checkout, so it follows the bytes this agent can actually see. Oxagen receives the run record, not a bulk copy of the code graph.' Then mention:  --max-steps caps the tool loop per turn (default 256), and --permission-mode goes ask → accept-edits → bypass → readonly. 'Local work is bounded here. Every request beyond this checkout, and all shared context, is answered by a rule in Oxagen.'",
      "DEMO 2 · FLEET MODE: Run:  oxagen agents  In the agents screen, type a goal like 'add rate-limit tests across the API routes'. Let the planner produce multiple tasks. Say: 'When a turn needs more than one task, Oxagen fans out governed sub-agents, each in its own isolated worktree, merged back, with full lineage.'",
      "DEMO 2 (cont.): Point at the Agent Team panel and task checklist as children run. Emphasize the cap: 'This fan-out is capped at 100 tasks per dispatch, depth 3, and 250 total descendants. Exceed it and the dispatch is denied. This is the per-turn budgeting that stops the mystery overnight bill at the cap.'",
      "DEMO 3 · RECORD: Switch to the browser: app.oxagen.sh → open a workspace → Activity. Open one recent run. Say: 'Here's that run step by step: every tool call with duration, tokens, cost, and status, and every sub-agent as child lineage. Nothing ran off the record.' (CLI parity: mention `oxagen trace` does the same in the terminal.)",
      "DEMO 3 · BILL: Navigate to Billing → Usage (/[org]/billing/usage). Say: 'This is the bill, explained. Total cost, tokens, cached tokens, then broken down by model, by surface, and by workspace, with a daily series. If a number spikes, I click straight to the team and the agent that caused it. No more unexplained invoice.'",
      "DEMO 3 · AUDIT: Navigate to Security → Compliance, then Security → Audit. Say: 'SOC 2 controls derived from live signal, not a static doc. And the audit log exports as signed NDJSON or CSV for your GRC team. Who did what, when, and why, for every agent action, tenant-isolated.'",
      "CLOSE THE DEMO: 'Three questions from the start of this call: what did it do, what could it touch, why did it cost that. You just watched all three answered, on your own model keys, inside your own controls.' Then flip BACK to the deck (Alt or Cmd-Tab to the deck window) and press → to land on the Thank you slide.",
    ],
  },
  {
    title: "Historical: Thank you / contact",
    say: "That's Oxagen: every agent under a mandate, every call priced, on your own keys. I'd like to scope a small pilot: one team, one runaway workflow, and the bill and the record explained in a week. What do you want answered first? Contacts are on screen: app.oxagen.sh, docs.oxagen.sh, and mac@oxagen.sh. Then open it up for questions.",
  },
];
