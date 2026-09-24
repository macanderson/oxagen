## Self-Evaluation — Agents + Runtimes lanes coverage audit — 2026-09-24

### What I set out to do
Audit the combined agents and runtimes change on claude/ecstatic-lamport-r8ddiu for untested branches in new or changed components, mappers, adapters and contracts, and add the missing tests.

### What I actually did (measurable deltas)
- 4 test commits, 8 new `it` blocks across 4 files; every new test file run alone once and green.
- Mutation-checked three: removing ListTable's numeric guard, collapsing OsLine's arch-null branch plus the hooksOk guard, and moving retired/suspended ahead of tamper in healthOf. Each turned its new test red.
- Merged one commit from origin/main (#3827) because the pre-push `check:system-db` compares the baseline against origin/main and main had since dropped an entry. gen:messages produced no diff after the merge.

### Quality of my decisions
- Best: choosing inputs where only the guard under test can refuse the column (numeric with two repeated values). The existing "Amount" case was also excluded by the one-value-per-row rule, so it proved nothing about the numeric guard.
- Weakest: not writing the DB-backed test for the `mandateHolders` 100 cap and slug fallback in agent.list.ts. I pinned only the contract's `.max(100)`.

### What I could have done better
- I could have checked for pre-push hook checks that read `origin/main` before the first push and found the stale baseline sooner.
- The stale-filter case (a chosen facet whose column stops qualifying after new rows) is still unpinned. It is a wart worth a characterization test.

### What surprised me about this codebase/product
`check:system-db` fails a branch whose own diff is clean once main removes a baseline entry, because it reads the baseline from origin/main.

### Risks I am leaving behind
- The `mandateHolders` slice(0, 100) and the `allKeys.get(r.id) ?? r.slug` fallback in packages/agent/src/handlers/agent.list.ts have no handler test. That needs the DATABASE_URL integration suite.
- phone.css card rules are asserted only in the Agents phone test, not in the Runtimes one.

### Confidence in the result: high for the added tests (run alone and mutation-checked); medium for audit completeness (the DB handler branch is not covered)
