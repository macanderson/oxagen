## Self-Evaluation — rev1 Billing coverage audit (claude/inspiring-einstein-rwklr9) — 2026-09-23
### What I set out to do
Audit every new or changed Billing component, adapter, mapper and UI primitive on the branch for co-located tests of its states and branches, and write the missing ones.
### What I actually did (measurable deltas)
- New: this-period.test.tsx (4), section.test.tsx (7), ui/table.test.tsx (2).
- Extended: list-table.test.tsx (+5 tests, +4 leadingNumber cases), billing.test.tsx (+10), change-plan.test.tsx (+1).
- Fixed a red test the lane shipped: change-plan.test.tsx still asserted the Checkout paragraph 995ee8a24 removed.
- Mutation-checked two page branches (empty-state cursor, balance-read failure); only the new tests failed.
### Quality of my decisions
- Best: reading billing.tsx for the value it always passes (discount: null) and so seeing that the recorded-total branch of ThisPeriod and the Due tile could never be drawn by a page test.
- Weakest: I did not run the other lane-modified test files (auto-topup, purchase-form, usage-credits, pages.test) because of the one-file rule, so a second stale test like change-plan's could still be waiting for CI.
### What I could have done better
- Grep every test file for strings removed from the message catalogue first; I did it after finding the change-plan failure, and it should be step one on any copy-heavy PR.
- Invoice status tones for uncollectible and void, and an unnumbered invoice, are still unasserted; I ranked them low and left them.
- The route's viewerName mapping (user null or empty name) in page.tsx has no test.
### What surprised me about this codebase/product
A lane commit message said "the plan dialog loses its extra paragraph" while the test asserting that paragraph stayed; the lane never ran the file.
### Risks I am leaving behind
- ListTable sorts a "not recorded" cell first in a descending numeric sort (characterized, not fixed: a design question).
- An invoices cursor past the last page prints "No rows match." rather than a sentence about the page (characterized).
### Confidence in the result: medium-high. Every new or edited file ran green alone; the rest waits on CI.
