/* Shared narration · single source of truth for the investor deck presenter. */
window.OX_SCRIPT = [
  {
    title: "Title · Oxagen",
    say: "Thanks for the time. In ten minutes I want to show you a category that is opening right now, and why we are the team to own it. Short version: agents are writing production code inside regulated companies, and nobody governs what those agents are allowed to know. We built the layer that does. Let's go.",
  },
  {
    title: "The shift already happened",
    say: "Start with what changed. In eighteen months, Claude Code, Cursor, and Copilot made agents genuinely productive. Every one of them makes an agent faster. None of them makes an agent accountable for what it read, what it touched, or what it cost. That gap used to live in a lab. It now lives inside banks and health systems. The Cloud Security Alliance surveyed 2,700 security professionals this year: fifty-three percent have already had an agent exceed its intended permissions, eighty percent have documented risky agent behavior like unauthorized access and data exposure, and only seven percent have a named person accountable for what an agent does. That is measured, not projected.",
  },
  {
    title: "The problem",
    say: "Here is the precise gap. Identity knows who the agent is. The gateway knows which tools it may call. Neither one sees inside retrieval, where the agent assembles a map of your systems and hands it to a model. A context engine with no permissions is a penetration-test roadmap. The March MCP disclosures were exactly this: legitimate credentials, legitimate tool calls, illegitimate context flows. The leak is not in the tool call. It is in the context window.",
  },
  {
    title: "The wedge we own",
    say: "This is the slide I would screenshot. Oxagen resolves every retrieval against the caller's contracted capabilities before a single node leaves the store. Not filtering after the fact. Not prompt guardrails. Authorization at the graph edge. Three consequences: an allowed node can never bridge into a denied subgraph, every agent borrows exactly its principal's view, and every answer carries a chain of custody you can replay. Gateways govern tool calls. We govern what the model reads. That plane is unclaimed.",
  },
  {
    title: "Why now",
    say: "Why this year and not last. Three things landed at once. MCP became the universal port, so for the first time there is one place to sit under every agent. Agents crossed into regulated buyers, where a leak is a breach. And governance became a board item through the EU AI Act, ISO 42001, and SOC 2. The buyers who own identity and a gateway already had incidents. The missing layer is not more identity. It is authorization on knowledge.",
  },
  {
    title: "What Oxagen is",
    say: "How it works, in one object. The capability contract binds identity to knowledge scope, permitted action, commercial terms, verified outcome, and audit record. That is the one binding nobody else bundles, and it is why a prompt injection cannot widen a tool. Standing it up is four steps: connect repos and we build a deterministic graph in your VPC, bind identity from Okta or Entra, point agents at one MCP endpoint, then govern and meter. About a day to first value.",
  },
  {
    title: "The moat",
    say: "Two moats, and both compound with every customer. The graph is an accuracy moat: the more work runs through Oxagen, the more accurate the grounding, and the harder we are to leave. Vendor-neutral BYOK is a trust moat: a neutral plane can sit under vendors who compete, a vendor grading its own homework cannot. We do not fight on connectors or evals or framework mindshare. The wedge is the binding, the graph, and the metering loop, bundled.",
  },
  {
    title: "Metering to billing",
    say: "The business model is built into the same event stream. Every token is observed, attributed to a team and an agent, and priced. The record that satisfies an auditor is the record that meters chargeback. And because agents resell downstream, the loop bills your customers too, on your own keys. Usage in, governed invoice out. Metering becomes revenue, not just a cost dashboard.",
  },
  {
    title: "Where we sit",
    say: "The competitive picture is simple. Identity issues the credential. Gateways ACL the tool. Only Oxagen governs what an agent may read, grounds the answer, and meters it into billing. Coding-agent vendors will govern their own agent, but you deploy five, so enforcement has to sit below all of them, in your VPC, answering to your identity provider. Neutral by construction.",
  },
  {
    title: "What is already built",
    say: "This is a running platform, not a promise. Capability parity is enforced in CI: every action ships as a typed contract, a REST route, an MCP tool, and a CLI command. Governance, the Neo4j and code graphs, the ClickHouse metering spine with per-turn budgets, and four surfaces on one contract spine are all live today. The full internals are in the architecture deck if your technical diligence wants them.",
  },
  {
    title: "Who is building it",
    say: "Thirty seconds on the team, because you are backing people. I have built and scaled businesses across multiple countries with hundreds of staff, so I know operational complexity that is not just code. Eight straight years on the Inc. 5000, which is the Hall of Fame. U.S. patent holder. And I have been building agents since the term existed. Oxagen is the system I wished existed every time an agent did something no one could explain.",
  },
  {
    title: "The ask",
    say: "The close. Agents are already in the enterprise codebase. The only open question is whether their context is governed. We are raising to win the context-governance wedge before the platforms realize it is a category: land design partners in financial services and healthcare, deepen the graph and the billing loop, and prove neutrality across every major model. We are raising a four million dollar seed on a twenty-two million post-money SAFE, about twenty-four months of runway to design-partner revenue and SOC 2 Type II. Reduce uncertainty before you invoke intelligence. That is the whole thesis, made investable. Let's talk terms.",
  },
];
