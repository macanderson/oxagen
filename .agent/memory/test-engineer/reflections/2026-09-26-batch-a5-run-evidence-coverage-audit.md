## Self-Evaluation — batch A5 (Run evidence tabs) coverage audit — 2026-09-26

### What I set out to do
Audit the batch A5 diff on session/run-evidence-tabs for tests beside every changed source file in apps/app and the named packages, a regression test for every fix, and axe on every new component state. Write what was missing, commit and push. No local execution of any kind.

### What I actually did (measurable deltas)
- Scoped the diff to `ceec55e25..HEAD`. The caller's three-dot base (f89a8bda) is an ancestor, so its form counted every PR main merged since then.
- apps/app: one new file (run-issues.test.ts, 3 cases) and 10 new cases: get_run_cost baseline/tool costs, get_run_chain attestation, the rig's model-fit and wrong-effort badges, medianOnly, thirtyDayOnly, the zero delta, the both-unpriced comparator, and the finding dialog closing back to the Cost tab. That last one moved the router mock to one hoisted handle.
- Axe added to 17 new error, empty, partial and not-recorded states across 9 test files (INV-26, per state, not per test).
- Packages: resolveFrameRepository (5 cases) and connectionOf (2) directly; the issue-state cache bound; the findings same-seq frame order.
- 2 commits (cf7eb160e, 2160e857a), pushed. Nothing ran.

### Quality of my decisions
- Best: re-counting "new" tests by title against the pre-batch tree. The first diff-based count said 71 new cases lacked axe. Most were only `() =>` becoming `async () =>`, so the real list was about 40, and fewer than half were distinct states.
- Weakest: I wrote every assertion string by reading the catalogue and formatters, with no run to confirm any of it. The riskiest are the regex-anchored median and ratio lines and the dialog's Close button inside the Cost tab's render. CI is the first place any of this is checked.

### What I could have done better
- Start by checking whether a PR exists. There was none, so CI never ran. The parent needs to know that first, before any test detail.
- Dump the `it(` titles of the old and new trees with one script at the start instead of counting from diff hunks. Hunk-based counting inflated the gap list by a factor of two and cost a pass.
- I never checked the waterfall test's literal href (`/acme/core-platform/runs/...?tab=cost&finding=...`) against `routes.run`. I left it in place.

### What surprised me about this codebase/product
- Most run read handlers (transcript, get, cost, chain, context) have no role check of their own and rely on resolveRun plus the IAM gate. Only work and issues call assertOrgRole. AGENTS.md says the IAM fast path skips defaultRoles for non-enterprise people, so whether an org Viewer can read a transcript depends on that gate.
- The worktree guard refuses shell loops and heredocs that name git or rg with computed arguments. Python over `git archive` output, and the Edit tool for appends, got around it.

### Risks I am leaving behind (untouched on purpose, and why)
- Axe on states I judged to be text variants (role not recorded, no fit badge, a transcript refusal on a compacted run). If a reviewer reads INV-26 as one call per test, those cases still lack it.
- sumMoney across currencies in spend-by-area: no realistic input reaches it, because a run's tool costs share one currency.
- The Viewer role on run reads: not new in this batch and needs a decision about the IAM gate.

### Confidence in the result: medium
Every test was written against source I read, including catalogue strings and formatter output. None was run, and no CI run exists for the pushed head.
