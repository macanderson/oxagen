## Self-Evaluation — coverage audit of public ids in `.oxagen/workspace.json` and CopyId (branch claude/hopeful-sagan-mz691w) — 2026-09-24

### What I set out to do
Find behavior in `d5c7084..HEAD` that no test pins, ranked by risk, and add the missing tests to the co-located files without touching source.

### What I actually did (measurable deltas)
- `apps/cli/src/commands/steering.test.ts`: 75 → 81 tests. Added three `it.each` blocks (mixed id forms, one id missing, id matching no record) over contract-shaped records that carry both `id` and `publicId`.
- `apps/app/src/features/organization/workspaces.test.tsx`: 14 → 15 tests. Added one sequence test for CopyId (success, refusal, success).
- Mutation-probed both files against scratch copies (a `*.probe.ts` mutant and a probe test importing or `vi.mock`ing it). 6 CLI mutants and 3 CopyId mutants killed. Four of the CLI mutants and all three CopyId mutants survived the pre-existing tests and die only on the new ones.
- Verified by reading the API that both lists return `publicId` from the same `public_id` column the app displays, and that `oxagen init` writes database ids.

### Quality of my decisions
- Best decision: making the "matches nothing" cases use a one-record list. The decoy-first public-id test already killed "take the first record", but only a no-match case with a single candidate kills the `?? list[0]` fallback, which is the tempting "helpful" edit and the one that would apply another workspace's gates to the checkout.
- Weakest decision: leaving the pre-existing database-id test with `org_1`/`ws_1` values and records that have no `publicId`. It reads like a public-id test. The mixed-form test covers the database-id arm with realistic records, so coverage is complete, but a reader still has to work that out.

### What I could have done better
- I wrote the CLI helper before checking whether Biome would reflow the `it.each` rows. Formatting afterwards changed the file on disk mid-session and forced a re-read. Format once right after writing.
- I did not typecheck the changed tests because the caller forbade it. The `it.each` heterogeneous rows (`{ orgId }` vs `{ workspaceId }`) rely on vitest's tuple inference overload; I reasoned it through but did not measure it. I should state this explicitly as unverified and not imply it is.
- I spent a query on the `.gitignore` docs claim before scoping the test gaps. It was right to check, but it should have come after the ranked list, not in the middle.

### What surprised me about this codebase/product
- The pre-existing rename test killed the "decide the form once from the prefix" mutant only by accident: its database-id fixture values start with `org_`.
- CopyId's status is sticky per instance. After copying the org id and then a workspace id, both say "Copied" while the clipboard holds only the second.

### Risks I am leaving behind (untouched on purpose, and why)
- CopyId never resets its status, so a stale "Copied" can sit beside an id that is no longer on the clipboard, and a repeat success is not re-announced to screen readers (same text in the live region). This is a source design choice. I did not pin it, because pinning would lock in the wart.
- Out-of-order settles (slow refusal after a fast success) make the status reflect the last promise to settle, not the last click. Low realism, not pinned.
- Exact matching: a hand-pasted id with whitespace or a `wrk_` id pasted into `orgId` resolves to nothing, and `readPlatform` drops the gates with no warning. That behavior predates this diff and changing it is a maintainer decision.
- No test pins that `list_orgs` and `list_workspaces.organization` read `publicId` from the same column; the handlers are unchanged here.

### Confidence in the result: high
Evidence: both files green in isolation after formatting (81/81, 15/15), and every new test kills at least one mutant that the pre-existing tests let through.
