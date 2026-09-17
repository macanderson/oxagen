## Self-Evaluation — audit PR #3233 (Workspace settings dialog / main repo binding) — 2026-09-17

### What I set out to do
Risk-weight the test coverage of ~4,800 added lines across contracts, handlers,
@oxagen/github, apps/api, apps/mcp and apps/app; judge the "behaviour-preserving
extraction" claim on apps/api/src/routes/v1/github-oauth.ts; judge whether the
dialog's five-states claim is real; find over-mocked tests; judge the ratchets.

### What I actually did (measurable deltas)
Read 18 source files and 8 test files in full. Found 5 genuine gaps, ranked, no
padding. Verified the RLS predicates on ingestion.source_connections and
ingestion.repository_binding_heads myself rather than assuming, which downgraded
my initial P1 tenant-scoping finding to a P3 note. Verified that installationId
is interpolated raw into app-auth.ts:105, which upgraded the installationIdOf
finding. Ran zero test suites.

### Quality of my decisions
- Best decision: chasing the RLS policy text before writing up "the where-clause
  predicates are untested". The org/workspace half is backstopped by RLS; the
  connectorId and deletedAt half is not. Without that check I would have filed a
  loud P1 that was two-thirds wrong and buried the one-third that was right.
- Weakest decision: I spent a long pass reading workspace-settings.test.tsx case
  by case to answer "does it fake the happy path", when the 44 test titles alone
  (each naming its refusal and marked "(negative)") answered it in one grep. I
  should have sampled three and moved on.

### What I could have done better
1. I did not check whether packages/github's `request()` retries or times out on
   the installation-repositories walk. MAX_PAGES=5 bounds the page count but not
   the wall clock, and this read blocks a settings dialog. A slow-dependency
   fault-injection test is the gap I am least sure I found.
2. I judged the coverage ratchets without a measurement, because measuring is
   banned here. I should have stated the specific uncovered branches I could
   name by reading (three in installationIdOf) instead of hedging generally.
3. I read the api test file's 42 test names before reading its buildValidState
   helper. The helper is what decides whether those names mean anything — it
   omits returnTo and hand-rolls the HMAC — and reading it first would have
   pointed straight at the round-trip hole.

### What surprised me about this codebase/product
`apps/app/src/test/arch/actions.test.ts` enforces INV-19 by parsing every
production file and selecting on the "use server" DIRECTIVE, not the filename.
That means loosening a layer rule to admit `kernelRead` from feature modules did
not open the hole it looks like it opens: the new actions module is swept into
the requireViewer check automatically with no new test. Arch tests as a
whole-tree invariant rather than per-file assertions is stronger than the
per-file coverage numbers suggest, and it changed my severity on the ADR-087
change from "needs a guard" to "already guarded".

Also: run.list.test.ts uses `drizzle.mock({schema}) + .toSQL()` to assert query
predicates. Most handler tests in this repo mock the drizzle chain and discard
the where() argument entirely, so the predicate-assertion pattern exists but is
used in ~5 files out of hundreds.

### Risks I am leaving behind (untouched on purpose, and why)
- bind_main_repository's handler still has no handler test. It is the write, it
  is the highest-blast-radius path in the diff, and this PR refactored it. I did
  not write that test because the task said report first, and because the file
  is pre-existing debt rather than this PR's new code.
- I did not verify the api↔app coupling of `?settings=repository&github=connected`
  by running anything; I compared the two literals by eye.

### Confidence in the result: high
Evidence: every claim in my report cites a file:line I read in this session. The
two claims I could not settle by reading (coverage percentages, the slow-GitHub
degradation) I marked as unsettled rather than guessing.
