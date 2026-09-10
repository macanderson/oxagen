## What & Why

<!-- One or two sentences: what this PR does and why. Link the Linear ticket. -->

## Issue link

<!-- Exactly one of:
       Closes #N   — this PR finishes the issue. Its DoD must be fully ticked,
                     or the `dod` check fails and the merge is blocked.
       Refs #N     — this PR advances the issue without finishing it. `Refs`
                     never closes anything, so no DoD is demanded.
       a label     — `no-issue` for a trivial change, `closes-nothing` for a
                     substantial one that deliberately closes nothing.

     Write it as plain text, NOT inside backticks. GitHub ignores a closing
     keyword in an inline code span or a fenced block, so `Closes #N` in
     backticks closes nothing — it reads as a claim and acts as none. A full
     issue URL does work, and counts exactly like the short form.

     A keyword anywhere in this body counts, not only here. So a sentence like
     "the operator's next command closes #123" closes #123 on merge, whether or
     not that was meant. Phrase such prose as "finishes #123" instead. -->

Closes #

## Vision Alignment

<!-- How does this advance the wedge (metering→billing, contract governance, graph
     grounding, vendor neutrality, fleet lineage)? Routine maintenance/fixes/tests
     are neutral by definition — just say so. If the Vision Gate posts a `drifts`
     verdict, justify the exception here. See docs/VISION.md. -->

## Checklist

- [ ] `pnpm gate` passes locally (lint, typecheck, tests, build, manifest, contracts, env, db)
- [ ] New/changed logic has unit tests; coverage ratchets hold
- [ ] New capability ships the full parity stack: contract → API route → MCP tool → CLI → `docs/capabilities/` (`pnpm check:manifest` clean)
- [ ] User-facing changes have E2E tests with screenshots (`apps/app/e2e/`)
- [ ] LLM calls go through `@oxagen/ai`; no hard-coded model slugs; DB access via tenancy helpers (no raw `db()`)
- [ ] Dep changes: added to the importing package's `package.json` + `pnpm i --no-frozen-lockfile` run
- [ ] Env var changes: registry + `.env.example` updated, `pnpm env:check` passes
- [ ] Migrations (if any) generated via Atlas, in `packages/database/migrations/`, verified with a post-apply query

## Verification

<!-- Concrete proof: test output, CI status, screenshots, DB query results. "Should work" doesn't count. -->
