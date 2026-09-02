/* Presenter script for the mutation verifier ship-note deck.
 * Consumed by the deck engine's teleprompter (press S). One entry per slide,
 * in slide order. `say` is the spoken line. POSITIONAL: inserting a slide in
 * index.html requires inserting an entry here at the same index. */
window.OX_SCRIPT = [
  {
    title: "The mutation verifier: title",
    say: "This is a ship note, not a proposal. As of this week the agent engine enforces a new law: after every judged-complete coding turn, the harness reverts the fix in a shadow and re-runs the agent's own test evidence. If the tests still pass without the fix, the turn does not ship. One sentence to hold onto: a test must fail without its fix.",
  },
  {
    title: "The failure class",
    say: "Why bother? Because the most embarrassing thing an agent can do is ship a no-op fix with total confidence. Four flavors: a vacuous test that asserts nothing, an assertion weakened until it passes, a fix in code the test never reaches, and a green that came from the environment healing itself. Every one of these fools an LLM judge, because the evidence genuinely looks good. None of them survives reverting the fix. That asymmetry is the whole feature.",
  },
  {
    title: "The mechanism",
    say: "The engine already tracked which test command flipped from fail to pass during the turn. That flip is the agent's own claimed witness. So the gate reverse-applies just the source half of the turn's diff, leaves the tests exactly as the agent wrote them, and re-runs that witness command. Fail means the green was real. Pass means vacuous, and the existing revise loop sends the agent back with one instruction: write a test that fails without the fix. And anything the gate can't do faithfully, it skips with a recorded reason. It fails open, never wrong.",
  },
  {
    title: "What shipped in V1",
    say: "Concretely: layer one is the witness gate, on by default in the turn pipeline, with an env and an option kill switch. Layer two is opt-in mutation scoring: deterministic one-line mutants of exactly the lines the fix added, and we measure how many the tests kill. There's an honesty guard, so a turn that never claimed test evidence isn't punished. Everything goes through the workspace port, so it's all unit-testable, and every verdict lands on the trace. Forty-nine new tests, coverage ratchet green.",
  },
  {
    title: "Why it matters",
    say: "Zoom out to the wedge. Our pitch is one enforced object binding identity, scope, action, commercial terms, verified outcome, and audit record. For coding work, verified outcome was the softest link, a model's opinion. It's now executed proof. And it compounds: the judge-skip ladder trusts the fail-to-pass flip, and the gate verifies that exact flip. Long term this is a billing story too: you can only charge for verified outcomes if you actually verify outcomes.",
  },
  {
    title: "The competitive read",
    say: "Everyone in this market answers 'is it done' with another model call. We run a judge too, but a judge can only read the evidence in front of it. The harness can manufacture better evidence by executing the counterfactual. Nobody else reverts the fix and demands the tests fail. It's mutation testing, a mature discipline, brought inside the agent loop and scoped to the patch at the moment of the claim.",
  },
  {
    title: "What comes next",
    say: "V1 is deliberately minimal, and every limit is a seam. LLM-guided semantic mutants through our metered AI layer. Filesystem-snapshot shadows, which also unlock time-travel replay. CI merge gates on kill rate with surviving mutants annotated on the PR. Verdict chips in the app UI. And my favorite: every vacuous verdict is a labeled real-world failure, so the gate becomes a data source that feeds the evals pipeline and trains against exactly the mistakes it catches.",
  },
  {
    title: "Close",
    say: "The price of the law is one extra run of a test command the agent already ran, and zero model calls. The payoff is that a green turn stops being an opinion and becomes a claim with evidence. It's on by default, everywhere the pipeline runs. Questions.",
  },
];
