## Self-Evaluation — e2e chat-agent-picker: chip vanishes after send — 2026-09-07

### What I set out to do
Root-cause the CI e2e failure at `apps/app/e2e/chat-agent-picker.spec.ts:64`
(`await chip.click()` times out after the message is sent, on a branch executing
ADR-043), fix it in app code, and prove it with a vitest test that fails before
and passes after — with no Postgres/Neo4j/Docker available, so no e2e run.

### What I actually did (measurable deltas)
- Identified a one-line regression in `apps/app/src/components/chat/message-composer.tsx`:
  ADR-043 commit `ae4b46968` changed `if (codeMode) lockSelection();` (origin/main:1538)
  to unconditional `lockSelection();` (branch:1224). That flips
  `ChatSelectionProvider.clientLocked`, which the composer forwarded as
  `locked={selectionLocked}` to `AgentContextChip`, whose locked branch renders a
  DIFFERENT element with `aria-label="Agent locked: ${label}"` instead of
  `"Agent: ${label}"` — so the spec's role locator matched nothing.
- Proved the flag path: `chat_ux_v2` defaults OFF, so `ChatSessionProvider` is not
  mounted and `useSessionSelectionBridge()` returns null. The earlier fix on this
  branch (`b144dcae8`, `selectionLocked: false` in `session-bridges.tsx`) therefore
  only patched the v2 path; the legacy `ChatSelectionProvider` the e2e actually uses
  still locked. That is why the first CI fix moved the symptom instead of removing it.
- Established the lock has no surviving server contract: `stream/code-binding.ts` is
  deleted, and `route.ts`'s BodySchema documents `agentId` as a PER-TURN parameter.
- Removed the agent-selection lock across 6 source files; updated 6 test files.
  12 files, +167/−278.
- Regression test: `message-composer.test.tsx` "keeps the agent chip live after a turn
  is sent — selection stays editable". Proved fail-before by reverting ONLY the 6
  source files to HEAD with the new tests in place (`regression-fails-without-fix.txt`),
  then restoring (`tests-pass-with-fix.txt`).
- 191 tests green across 10 implicated files; `tsc --noEmit` and
  `eslint --max-warnings 0` clean; biome clean. Artifacts in
  `verifications/session_01R1rEhwUGi1z1ob1v4jbtax/`.

### Quality of my decisions
- **Best decision:** refusing to stop at "the chip is disabled, make it enabled".
  I checked whether the *server* still had anything for the lock to protect. Finding
  `code-binding.ts` deleted and `agentId` documented as per-turn is what turned a
  cosmetic label fix into a correct semantic removal — and it exposed two further
  latent defects the e2e never would have caught: the v2 bridge left the picker
  *openable but silently non-committing* (writes rejected by `locks.agent`), and the
  client latch was one-way, so a FAILED send stranded the picker on a conversation
  with zero messages.
- **Second-best:** proving fail-before by reverting only the source files rather than
  trusting my earlier pre-fix run. That is the artifact that makes the claim checkable.
- **Weakest decision:** I let the scope question ("minimal fix" vs "no dead code")
  churn for a long time before committing to an answer. I re-litigated the same
  trade-off at least four times. The cascade was actually forced — removing the lock
  from `ChatSelectionStore` leaves `lockSelection` uncalled, which leaves
  `noteMessageSent`/`clientLocked` uncallable — and I should have drawn that
  dependency graph once, seen it was closed, and moved. Cost: real time, no better
  outcome.

### What I could have done better
1. **I should have grepped the flag before reading any component.** Almost an hour of
   my reasoning assumed the chat_ux_v2 session store was live. One `cat src/lib/flags.ts`
   plus one grep of `.env.example` at minute two would have told me the e2e runs the
   LEGACY store, and I would have gone straight to `chat-selection-context.tsx` instead
   of spelunking `session-store.tsx`'s hydration effect. When a bug reproduces on one
   surface and not another, resolve which code path is live BEFORE reading either.
2. **I wrote three python patch scripts whose final `assert X not in s` matched my own
   new comment text**, silently discarding all prior in-memory edits because the write
   came after the assert. Twice. I should assert on code tokens (`store.noteMessageSent`,
   `locked={`) rather than bare identifiers, or write first and verify by re-reading.
3. **I did not check whether other e2e specs assert the locked chip.** I grepped the
   repo for `selectionLocked|lockSelection|noteMessageSent|agent-context-chip-locked|Agent locked`
   and found nothing outside my own comments, which is good evidence — but I never ran
   the e2e specs (I can't) and I did not read `mobile-nav`/`sessions` specs to see if any
   depends on a post-send disabled composer control. Residual risk, stated below.
4. **I should have questioned the branch's own green unit test sooner.** The test
   `it("locks the agent chip after a turn is sent")` was sitting in the file asserting
   `data-locked="true"`. Seeing a unit test that *asserts the bug* is the fastest possible
   confirmation of a behavioural regression, and I found it late — only when hunting for
   a place to put my new test.

### What surprised me about this codebase/product
- The composer resolves its selection store through a three-way fallback
  (`sessionBridge ?? shared ?? local`) gated by a feature flag that is OFF by default.
  That means the *tested and shipped* path and the *feature-flagged* path have separate
  lock implementations, and a fix applied to one looks like a fix. This is a structural
  trap, not a one-off bug: any future change to selection semantics must be made in both
  stores or in neither.
- `hasMessages` is `messages.length > 0 || isStreaming` and `setIsStreaming(true)` fires
  synchronously at submit — so the entire `clientLocked` latch that existed "to cover the
  send→revalidate gap" was provably redundant, and strictly worse (it never released).
- ADR-043 is unusually well-written for tracing residue: the contract-families list let
  me confirm in seconds that the code binding was intentionally deleted rather than lost.

### Risks I am leaving behind (untouched on purpose, and why)
- **Cannot run Playwright here.** The claim "the e2e now passes" is an inference from the
  DOM contract (the chip renders exactly one element, `aria-label="Agent: ${label}"`),
  plus a traced re-hydration path showing `ChatSelectionProvider`'s draft→conversation
  carry-over preserves the agent across the `?c=` URL pin. CI shard 1 is the real gate.
- **The v2 session-settings `AgentRow` lock timing changed sources** (client latch →
  `hasMessages`). I argued equivalence from `chat-shell-client.tsx:587` vs `:1569` and
  the tests pass, but the v2 surface is flag-off so no e2e exercises it. Low blast radius.
- **`apps/app/e2e/` was not audited for other assertions on a locked composer.** Repo-wide
  grep was clean; I did not read every spec.
- **I did not touch `coverage/coverage-final.json`** (stale gitignored build artifact that
  still references `lockSelection`). Regenerated on the next coverage run.

### Confidence in the result: high
Evidence: (a) the regression is a single identified line diffed against `origin/main`,
where the test passes; (b) the new test fails with the source reverted and passes with it
restored, captured as artifacts; (c) 191 tests green across all 10 implicated files;
(d) `tsc --noEmit` exit 0, `eslint --max-warnings 0` exit 0, biome clean; (e) repo-wide
grep shows no surviving reference to the removed API. The one gap is the absence of a
real browser run, which is CI's job.
