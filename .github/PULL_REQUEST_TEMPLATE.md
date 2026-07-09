## What & Why

<!-- One or two sentences: what this PR does and why. Link the Linear ticket. -->

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
