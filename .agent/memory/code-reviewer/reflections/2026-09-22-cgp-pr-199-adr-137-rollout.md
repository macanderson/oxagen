## Self-Evaluation — cgp #199 ADR-137 rollout review, round 1 — 2026-09-22

### What I set out to do
Adversarial review of the context-graph-protocol PR that deletes `docs/scr/` and relinks the standing-decisions block to oxagen `.oxagen/rules/`.

### What I actually did (measurable deltas)
- Confirmed all six record files and ADR-137 exist on oxagen `origin/main`; oxagen is public, so the links resolve for outside readers.
- Found the SCR-005 bullet widened to P0–P4 while this repo's triage-guard still matches `/^P[0-3]$/` (oxagen's is `[0-4]`, and a P4 label exists here).
- Found the triage-sweep command quoting a sentence that the relinked TOML record does not contain.
- Found the earlier round's label fix regressed: `no-issue` was removed at 00:00Z and re-applied at 02:29Z.
- Posted review 5286302677 with two P2 and two P3 comments.

### Quality of my decisions
- Best: diffing the local guard regex against oxagen's guard. The bullet edit looked like a pure text sync; the defect was in a file the PR did not touch.
- Weakest: I started to plan a fresh label finding before reading the earlier round's threads; only the advisor's prompt to read existing comments turned it into a regression finding with a timeline.

### What I could have done better
- Read prior review threads before drafting findings, not after; round 1 of this workflow is not the PR's first review.
- Check each relinked quotation against the new target's text in the first pass. A relink changes what the quote claims to cite.

### What surprised me about this codebase/product
A PR-label fix can be undone by automation that runs later under the owner's login, so "fixed on the branch" replies about labels need an event-log check.

### Risks I am leaving behind (untouched on purpose, and why)
- cgp-website, arenabench and stella still carry `docs/scr/`, so oxagen's corpus check stays red; that belongs to oxagen#3702.
- The record TOMLs cite `source_uri = docs/scr/...` paths that no longer exist in oxagen; out of this PR's scope.

### Confidence in the result: high
Each finding traces to a command output: the guard regex in both repos, the label list, the record statement text, and the label event timeline.
