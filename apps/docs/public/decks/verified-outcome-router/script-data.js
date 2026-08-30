/* Presenter script for the verified-outcome market router deck.
 * Consumed by the deck engine's teleprompter (press S). One entry per slide,
 * in slide order. `say` is the spoken line; `demo` is an optional step list. */
window.OX_SCRIPT = [
  {
    title: "Verified-outcome market router: title",
    say: "This deck is about one feature with a long fuse. Today it is a smarter way to pick which model runs each subtask. At the end of the roadmap it is something nobody else can sell: accuracy with an SLA and a price tag, refunded automatically when we miss. I'll show you what exists today, what just shipped, and where it goes.",
  },
  {
    title: "The problem",
    say: "Start with the uncomfortable truth: across this industry, model choice is a vibe. Static rules pick the tier. Engineers pin models based on intuition from three months ago. Prices drift weekly and the routing never notices. And nobody joins verified success to cost, so nobody knows if the expensive model earned its premium. At fleet scale, one bad default multiplies into thousands of misrouted turns a day.",
  },
  {
    title: "What we have today: routing machinery",
    say: "Oxagen already has real routing plumbing. A deterministic classifier sorts every task into fast, balanced, or precise, and high-stakes domains like auth and billing always get the precise tier. Humans can pin models per role. A budget guard caps per-turn spend. This is good machinery. What it lacks is feedback: the router never learns from what happened.",
  },
  {
    title: "What we have today: the data exhaust",
    say: "Here's the asset most people don't realize we have. Every single LLM call already lands in ClickHouse with its model and its provider cost, billing-grade, a year of retention. Our eval suite records model-attributed correctness scores. Every agent turn produces a judge verdict, and executed tests give the strongest signal of all. Three stores. Never joined. The record a learned router needs, verified success per model per task class with a price on it, simply did not exist. That is the gap we just closed.",
  },
  {
    title: "What ships now",
    say: "V1 ships three things. The data spine: a router_outcomes table joining task class, model, verified result, cost, and latency. The decision core: a pure function that picks the cheapest model whose verified success rate clears the policy bar, returning the full candidate table as an audit trail. And the governance: policy per org or workspace, four capabilities on API, MCP, and CLI. When the judge rejects a result, we now escalate a tier instead of retrying the same model and hoping. Sparse data falls back to today's classifier, and a manual pin always wins.",
  },
  {
    title: "The market metaphor",
    say: "The mental model comes from equities. An order goes to the venue with the best execution at the best price, and the routing decision itself is auditable. Same discipline here: per task class we keep a book of venue quality from our own metered history, policy sets the execution-quality bar, and the cheapest eligible venue gets the fill. Ties break on accuracy, then latency. And because the curve refits from live history, routing drifts with the market instead of behind it.",
  },
  {
    title: "Shadow first",
    say: "How do you turn this on without betting production on it? Three modes. Off is the default and changes nothing. Shadow computes every market decision and records what actually ran and whether it verified, but acts on none of it. Your curves fill up on your own traffic at zero risk. Enforce is a decision you make while looking at your own data, and the preview capability shows you exactly what would change before you flip it.",
  },
  {
    title: "Roadmap: phases one and two",
    say: "Phase one makes the data trustworthy: confidence bounds instead of raw rates, tenant curves blended with platform-global curves so small tenants get real statistics, and a dashboard that shows what the market router would have done and what it would have saved. Phase two makes the economics live: gateway prices sync automatically, and the objective upgrades from cheapest-above-threshold to maximizing verified success under the turn budget, with latency as a third axis.",
  },
  {
    title: "Roadmap: phase three",
    say: "Phase three replaces the bootstrap. Learned task signatures from prompt embeddings take over from regexes. Contextual bandits give under-sampled venues a small, policy-capped share of verified traffic, metered as a visible line item. And new models go through paper trading: scheduled evals built from real traces before they ever touch production. Promotion to routable happens automatically when the confidence gate clears.",
  },
  {
    title: "Roadmap: the endgame",
    say: "And here is the endgame, the pure Stripe-for-agents move. An SLA attached to a task class: at least ninety-five percent verified success at fifty cents or less, or the credits come back. Enforced by the same metering-to-Stripe loop that billed the usage. No ticket, no dispute thread, an automatic ledger entry with a full audit trail. Finance teams get per-invoice attainment statements, and resellers publish their own SLAs on top of ours with their own margin.",
  },
  {
    title: "Why it matters",
    say: "Why can't anyone else do this? Because it takes the whole loop. Observability vendors see cost but never verify outcomes. Eval platforms verify offline but neither meter nor bill. Frameworks own the loop but none of the accounting. Pricing and guaranteeing accuracy needs the meter, the verifier, and the billing rail in one system. That is exactly the accountability chain we already enforce on every capability, turned into a market mechanism.",
  },
  {
    title: "Close",
    say: "So the ask is small and the payoff compounds. Flip a workspace to shadow mode today. Zero behavior risk, and the curves start accumulating immediately. When your own data says the cheap venue clears the bar, enforce is one policy change. Accuracy stops being a vibe and becomes a product: priced, guaranteed, and auditable. That is the verified-outcome market router.",
  },
];
