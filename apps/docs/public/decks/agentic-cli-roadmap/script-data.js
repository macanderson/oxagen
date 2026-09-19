/* Shared narration · single source of truth for the CLI accuracy and performance roadmap presenter. */
window.OX_SCRIPT = [
  {
    title: "Historical: Title · CLI roadmap",
    say: "Historical presentation. Product, pricing, and security claims may be obsolete. Use the current docs for setup and supported features. This deck is about one product surface, the Oxagen CLI, and one question: how does Oxagen make it the most accurate and most performant coding agent on the market, without wasting money on AI. The setup matters. This month the frontier models converged at ninety-five percent on SWE-bench Verified. When every serious player has the same model quality, the harness decides who wins. Oxagen already owns the four assets a winning harness needs. This is the plan to cash them in.",
  },
  {
    title: "Historical: 01 · What the CLI has today",
    say: "First, the honest baseline. The spine is already competitive. The SWE-bench harness solves tasks single-shot at forty-nine cents, checked by executed tests, and it beat Claude Code head to head. Fleet fan-out with full lineage, per-turn dollar budgets, deterministic fast paths for simple prompts, a local code graph, persistent sandboxes, a scope-review gate, and memory recall. None of this is a demo. It is all shipped and metered.",
  },
  {
    title: "Historical: 02 · What changed by July 2026",
    say: "Now the landscape. Three numbers. Ninety-five percent: the frontier models converged on SWE-bench Verified this month, so the model is table stakes. Seven points: the same model swings seven points on Terminal-Bench depending on which harness wraps it. The loop, not the weights. And thirty-five plus actively maintained CLI agents: crowded distribution, scarce differentiation. One more thing from CMU: naive test-time scaling has a ceiling, and the binding constraint is verifier quality. Hold onto that word, verifier.",
  },
  {
    title: "Historical: 03 · Why Oxagen wins",
    say: "Why does Oxagen win this? Because every frontier technique needs infrastructure Oxagen already runs in production. ClickHouse holds every LLM call metered with prompt hashes, which is training data for the harness itself. Neo4j holds bi-temporal facts, memory that can learn and forget on the same clock as the code. Contracts give every new mechanism identity, scope, and audit for free. Sandboxes give cheap parallel universes. A competitor has to build all four before they can copy any one idea in this deck.",
  },
  {
    title: "Historical: 04 · Phase 1, verified green",
    say: "Phase one, weeks not months: never ship a false green again. Two pieces. The mutation verifier reverts the fix in a shadow sandbox and reruns the test. If the test still passes, it was vacuous, and the turn is rejected before anyone sees it. And un-poisonable edits: every edit is hash-anchored, AST-applied, and gated on the typecheck delta, so a patch that lands on the wrong line becomes structurally impossible. No other CLI on the market checks that its tests witness its fixes. This is the accuracy floor.",
  },
  {
    title: "Historical: 05 · Phase 2, feels instant",
    say: "Phase two is about feel. Speculative tool calls are speculative decoding lifted one level up: a tiny local model predicts the next few tool calls while the big model is thinking, and runs them into a cache. Right predictions return instantly. And the debugger in the loop: sandboxes expose the Debug Adapter Protocol as contracts, failing tests run under a debugger, and the agent reasons from the path the code actually took instead of grep and guess. Reads are seventy percent of turns. Hide their latency and the product feels like a different species.",
  },
  {
    title: "Historical: 06 · Phase 3, compounding memory",
    say: "Phase three puts time on your side. The learning code-fact graph writes every verified discovery back as a cited, time-scoped fact, and the bi-temporal machinery expires facts when the code that grounded them changes. The thousandth run on a repo starts with everything the previous nine hundred ninety-nine established. Time-travel replay is a write-ahead log for agent runs: bisect any failure, resume from any step, and auto-distill every failure into an evaluation case. Run macros compile the most repeated workflows into deterministic fast paths.",
  },
  {
    title: "Historical: 07 · Phase 4, the economic moat",
    say: "Phase four is where engineering becomes business model. The self-evolving harness mines Oxagen's own run record nightly and ships patches to itself, each checked against evaluation cases. Tournament mode forks risky turns into parallel rollouts and lets executed tests pick the winner, with the budget deciding how wide the fork goes. And the verified-outcome router places every subtask on the cheapest model that clears its verified success threshold, which sets up the closer on the next slide.",
  },
  {
    title: "Historical: 08 · The plan on one screen",
    say: "Here is the whole plan on one screen. Each phase pays two dividends, one in accuracy and one in performance. Phase one rejects false greens and cuts torn-patch retry loops. Phase two grounds fixes in runtime truth and hides read latency. Phase three makes run N measurably better than run one and runs idiomatic tasks at machine speed. Phase four turns verified success rates into guarantees and spend into the cheapest model that clears the bar. Sequenced by payoff over effort.",
  },
  {
    title: "Historical: 09 · Why it matters",
    say: "So why does this matter beyond the CLI? Because it completes the accountability chain: identity, scope, permitted action, verified outcome, audit record. Once every fix is checked by executed tests and mutation witnesses, the metering loop can bill on verified outcomes instead of tokens burned. The slide makes the promise every buyer needs: see which agent spent what, and on whose behalf. Oxagen can, because it owns the loop from observed work to Stripe.",
  },
  {
    title: "Historical: 10 · Close",
    say: "The close. Verified, instant, compounding, priced. Four phases, one direction: a coding agent whose claims are checked by running them, whose speed comes from prediction, whose memory outlives the run, and whose accuracy carries a guarantee. See which agent spent what, and on whose behalf. That is the roadmap, and it is the moat.",
  },
];
