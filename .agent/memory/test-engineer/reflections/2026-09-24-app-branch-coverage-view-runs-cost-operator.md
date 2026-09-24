## Self-Evaluation — apps/app branch coverage: fleet/view, live/runs, run/cost, ui/operator — 2026-09-24
### What I set out to do
Cover every reachable uncovered branch in four apps/app sources (about 43 uncovered branches) with behaviour tests and no production change, so the apps/app 90% branch threshold passes again.
### What I actually did (measurable deltas)
- view.test.ts: 21 -> 29 tests (natural-order text sort, started sort, stable ties, two unpriced rows, a row with no words, oldest approval out of order, a negative window, pager edges, rowsPerPageOf).
- runs.test.ts: 22 -> 36 tests (a refusal passes through all 7 reads, plus outcomesSettings, work, and outputs, each with a mapped and an unmappable case).
- cost.test.tsx: new, 8 tests. operator.test.tsx: new, 15 tests.
- Mutation-checked one new test per file by breaking the source and restoring it: each break turned a named test red.
- Lint and typecheck-staged.mjs are clean on all four files. Coverage was not run locally, per the brief.
### Quality of my decisions
- Best: a table-driven "refusal passes through" block over every runs read. It covers 7 `!read.ok` branches in one readable place, and it asserts captureError stays silent.
- Weakest: I estimated the branch counts by reading the source rather than measuring them. The brief forbade coverage runs, so the per-file numbers in my report are inferred.
### What I could have done better
- I wrote `as const` twice before checking apps/app's `assertionStyle: "never"`. Reading eslint.config.mjs first would have saved two edit rounds.
- The tie-breaker test (`|| i - j`) covers the branch, but a mutation that removes it survives because Array.prototype.sort is stable. I should say that in the test comment, not only in the report.
- In the operator test, `not.toHaveTextContent("Id")` is a substring check on a label. Scoping to the grid's term cells would be more robust against copy changes.
### What surprised me about this codebase/product
Two view.ts guards are unreachable by design: `x === null ? 1 : -1` in compare(), which nullLast() already answers, and `!a || !b || !wa || !wb`, a guard needed only for noUncheckedIndexedAccess. They will stay uncovered, and 90% branch coverage has to absorb them.
### Risks I am leaving behind (untouched on purpose, and why)
The unreachable branches above. Removing them is a production change and was outside the brief. The operator card's role="tooltip" is not referenced by aria-describedby. axe passes, so I left it alone.
### Confidence in the result: high. Every file passes in isolation and each file's mutation was caught. The exact coverage delta awaits CI.
