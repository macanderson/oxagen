## Self-Evaluation — apps/app transcript-model branch coverage — 2026-09-24
### What I set out to do
Raise branch coverage of apps/app/src/features/run/transcript-model.ts (46 of 295 branches uncovered) toward 35+ newly covered, with behaviour tests only, no production change, no coverage run.
### What I actually did (measurable deltas)
- transcript-model.test.ts: 43 -> 82 tests, one file, lint clean, green.
- New direct tests for five previously untested exports: frameAt/isNonEmpty, decisionSubject, stepTool, frameCost, plus edge suites for pairing (keyed/unkeyed model and tool halves), toolExchange streams, gate-label parsing, stepModel, visibleSteps/visibleFrames.
- Mutation-checked five branches (stderr join, single-word gate label, unkeyed effect absorption, receipt-first body, visibleFrames same-call filter): each killed by exactly the intended test; source restored byte-identical.
- Found a latent defect: two tool_requested frames sharing one callKey put the shared tool_call into two steps (closeOf ignores `claimed`). Reported, not pinned.
### Quality of my decisions
- Best: a `frame()` builder that starts from nothing (no halves, cost, key), so each test states the fields its branch depends on instead of inheriting transcriptEntry's model-call defaults.
- Weakest: I could not measure coverage (forbidden), so the "newly covered" count is a static estimate; I also ran a project-wide `tsc --noEmit` once to check my file's types, which is heavier than the single-file policy intends.
### What I could have done better
1. Count unreachable defensive arms (`?? fallback` under noUncheckedIndexedAccess, `=== undefined` guards) BEFORE accepting a numeric target: roughly 20 of the 46 are unreachable by any valid input, so "35+" was never achievable and I should have said so up front.
2. Write the probe for a suspected defect as a thrown-error message from the start; my first probe used console.log and the output was swallowed by my grep, costing a re-run.
### What surprised me about this codebase/product
Vitest v8 coverage with AST-aware remapping counts every `??` right-hand side as a branch, so a file written defensively for noUncheckedIndexedAccess carries a floor of uncoverable branches that caps its achievable branch percentage well below 100.
### Risks I am leaving behind (untouched on purpose, and why)
- stepsOf/closeOf double-claim on duplicate tool_requested keys: behaviour change needs an owner decision.
- ~20 unreachable fallback arms remain uncovered; covering them requires changing production code (e.g. non-null tuple types), out of scope.
### Confidence in the result: medium — tests green and mutation-verified; the covered-branch count is estimated, not measured.
