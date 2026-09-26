## Self-Evaluation — batch A2 (run page defects) coverage audit — 2026-09-26

### What I set out to do
Audit every behavior change on `session/run-page-defects` against origin/main
(#3370 findings 4, 7, 9 and 11, #4334, #3665 item 3, #3791, #3790, #3784,
#3814), confirm a test pins each one, and write the missing tests without
running them.

### What I actually did (measurable deltas)
- Read the whole source diff (82 files) and every lane test beside it. An
  earlier audit pass (6cbc18dfe) had already covered the apps/app branches,
  so every new app branch (Fleet ledger dialog, Fork role gate, header and
  Chain plumbing) already had a test.
- Found six unasserted behaviors, all in packages, and wrote seven tests in
  five files (commit 5e4ae9f92):
  - due implies candidate over 384 row states (run.enrich.test.ts)
  - scratch cleanup after an earlier read attempt, on no_retained_text and on
    a read that finds no run (run.enrich.test.ts)
  - getScratch of a missing name fails with StorageNotFoundError
    (evidence-store-scratch.test.ts)
  - the body-read ceiling cuts only at a frame that opens a body
    (run-enrichment.test.ts)
  - readWords with `only` leaves a body-less half out of its answer
    (run.transcript.get.test.ts)
  - checkout_limit is judged on the rows read, before the fold
    (run.work.get.test.ts)
- The commit hook's lint and staged typecheck passed on all five files.

### Quality of my decisions
- Best: the due-implies-candidate walk. The batch ANDs a new predicate into
  the sweep's WHERE, and the lane's tests proved only that the index and the
  query render the same text. A narrowed candidate predicate would drop due
  runs silently, and no existing test would go red.
- Weakest: I wrote "672 row states" in the commit message from memory. The
  product is 384. I caught it before pushing, but only on a reread.

### What I could have done better
1. Compute every number in a commit message with a command before writing
   it. A reader acts on it.
2. Check whether the prescribed commit command runs the lint and typecheck
   hooks before planning around "no typecheck". It does, and it would have
   told me sooner that the worktree had node_modules and a type gate.
3. The body-read ceiling test pins a behavior whose doc comment says "no
   frame is added" past the ceiling, while body-less frames are still added.
   I pinned the code and did not fix the comment. The comment is in
   run-enrichment.ts, a file this audit does not own.

### What surprised me about this codebase/product
- `evaluateDue` in run.enrich.test.ts compiles the real drizzle SQL and
  evaluates it in memory. It can evaluate any predicate over the same
  columns, which made the implication test cheap.
- The scratch cleanup depends on an error's `name` string across two
  packages, and nothing asserted it at the storage end.

### Risks I am leaving behind (untouched on purpose, and why)
- None of the seven tests has run. I was told not to run them. The staged
  typecheck and lint passed. CI is the first run.
- The `run-enrichment.ts` doc comment on the body-read ceiling overstates
  what stops. It is a comment, not a defect in behavior.
- Mutation probes were not run, so "fails if the behavior changes" rests on
  reading the branch each test reaches.

### Confidence in the result: medium
Each test's path was traced against the source line by line, and the hook's
typecheck passed. No test has executed yet.
