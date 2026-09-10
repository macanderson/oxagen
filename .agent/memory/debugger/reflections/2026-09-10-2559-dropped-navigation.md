## Self-Evaluation — #2559 dropped App Router navigation — 2026-09-10

### What I set out to do
Identify the root cause of the rotating `waitForURL` timeout from a trace
artifact and state it in the issue (the issue's sole DoD item).

### What I actually did (measurable deltas)
Read the one failing-attempt trace in the 2026-09-06 artifact that the thread
had explicitly flagged as unopened. Established from it that the click handler
runs, the router dispatches a real navigation (RSC fetch at +75 ms with
`Next-Router-State-Tree` and no `Next-Router-Prefetch`), the payload is complete
(157 067 B, 20 rows, 13 lazy refs, 0 unresolved), and the commit never lands
(frameUrl and `Next-Url` constant for 20 s). Falsified three candidates
including my own leading one. Fixed a retired-route reference in
`apps/app/e2e/helpers/signup.ts`. Posted the finding; commit 599372bc0.

### Quality of my decisions
- Best: checking `Next-Router-Prefetch` on the post-click requests. That single
  header separates "prefetch noise" from "the router really navigated", and it
  is what turned a four-week-old open question into a settled one.
- Weakest: I spent several tool calls chasing the ~208 ms screencast cadence as
  evidence of a React re-render storm before realising a GIF animates in the
  compositor. I should have identified the animating asset before theorising.

### What I could have done better
1. I read the issue's 11 comments first (right), but then still re-ran the
   PPR/InvariantError lead the thread had already falsified, because my task
   brief told me to "chase it". I should have reconciled brief against evidence
   before spending calls, not after.
2. I nearly landed the `/ask` → `/sessions` change blind on a helper used by all
   122 specs. I only found the proving unit test (`proxy.test.ts`) after
   deciding to change it. Find the equivalence proof before editing, not after.
3. I did not check whether a red run existed *after* #2771 merged until several
   calls in; that single check ("has the fixed instrumentation ever run?")
   reframed the whole task and should have been first.

### What surprised me about this codebase/product
`cacheComponents: true` puts `apps/app` on Next 16 PPR *and* the client segment
cache, so every navigation is preceded by `/_tree`, `/_head` and `__PAGE__`
segment prefetches. Nothing in the issue thread knew this, and it changes what
"the RSC request returned 200" means.

### Risks I am leaving behind (untouched on purpose, and why)
The drop itself is unfixed; A-vs-B (transition never commits vs router discards)
cannot be separated from a trace, and any app-level change would be a guess.
The `/ask` → `/sessions` change is unverified by an actual e2e run (needs the
three-container rig); it rests on `proxy.test.ts` equivalence plus CI.

### Confidence in the result: high / medium / low + evidence
High for the finding (multiple independent trace signals, plus a
same-run passing control with identical request shape). Low for the underlying
mechanism, and I said so in the issue rather than picking one.
