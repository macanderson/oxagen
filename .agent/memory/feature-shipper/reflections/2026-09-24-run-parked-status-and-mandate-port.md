## Self-Evaluation — port #3968's Run and Mandate pieces onto #4033 (#4070) — 2026-09-24

### What I set out to do
Port six items from the closed #3968 branch onto the rebuilt Run page (#4033)
and the Mandate page, only where each improves the experience, with a test and
a negative case for each.

### What I actually did (measurable deltas)
- Ported: header status word (parked/paused, live region), Resume in the pause
  banner, sr-only parked text and tab/tabpanel wiring, Wasted reads not
  recorded, Mandate money limits editable and scaled by the stored kind.
- Skipped: the Outputs "Review the approval" drawer button (main already links
  to the Governed actions tab, which decides the call in place with its frame),
  `ledger-table.tsx`, `authority-bar.tsx`, `state.tsx` and Fleet's stub dialogs
  (main already has a ledger table, authority list and failure states, and its
  read-failure deliberately draws no send-nothing dialog).
- Two commits, 18 files. Test files run, one at a time: controls 34, run 135,
  metrics 36, cost 18, catalog-used 5, money 105, mandate actions 45,
  mandate-actions 14, mandate 37, import-graph 110. All green.

### Quality of my decisions
- Best: reading the kind server-side only when the unit is a currency. Count,
  calls-cap and date edits keep main's one-write, no-read shape and every
  existing test in that file passed unchanged.
- Weakest: keeping the header's Resume beside the banner's. Two Resume buttons
  sit about 100px apart on a paused ledger run. I judged the banner's in-place
  action worth it, but a reviewer may fairly call it duplicate noise.

### What I could have done better
1. Phase 0 recall: I reported "no memory" because the sparse worktree hid
   `.agent/`. I should have checked `git ls-tree origin/main .agent` before
   concluding, not after the work was done.
2. I first wrote the money read to run only when a figure changed, then found
   main's test "refuses a unit the form cannot write even when it equals the
   prefill". Reading the existing negative tests before designing the money
   path would have saved a rewrite.
3. I did not get the test-engineer coverage audit CLAUDE.md asks for, because
   this harness gave me no agent-dispatch tool. The caller should run it.

### What surprised me about this codebase/product
- The issue's premise for item 4 was partly stale: #4033 already shipped
  "Review the approval", as a link rather than the drawer.
- The shared scratchpad is written by other sessions: my commit-message file
  was overwritten seconds after I used it.

### Risks I am leaving behind (untouched on purpose, and why)
- A legacy mandate limit whose stored kind is ADR-108's fallback guess is
  scaled by that guess. That is the same kind the page already displays, and
  the handler re-stamps the kind from the declaration on write.
- `metrics.ts` is also being changed on another branch (pricing). I touched
  only the Wasted lines and one import line, so a small conflict is possible.

### Confidence in the result: medium-high
Every changed behaviour has a component or action test with a negative case,
and the three new Run component states run `expectNoAxe`. Full CI has not run.
