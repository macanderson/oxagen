---
name: ci-green
description: Run full CI gate locally, push to main, watch CI until all gates pass, verify environment files in sync
---

# CI Green

**Purpose:** Standardized workflow to verify CI is fully green before any claim of completion or deployment. Ensures lint, typecheck, coverage, tests, builds, and migrations all pass — both locally and in CI.

**When to use:** Before pushing to main, before declaring a task complete, or when investigating CI failures. Use this skill to guarantee green CI status with proof.

## Instructions

1. **Run the full lint, typecheck, coverage, and test suite locally**
   - Execute `pnpm gate` from the repo root
   - This runs: lint (–max-warnings 0), typecheck, coverage, test, build, migrations
   - All must pass locally before proceeding
   - If any gate fails: fix the root cause (don't suppress, don't defer)

2. **Verify .env.example and lockfile are in sync**
   - Check `.env.example` contains all required env vars referenced in the codebase
   - Verify `pnpm-lock.yaml` matches all `package.json` files (no drifts)
   - Run `pnpm install --frozen-lockfile` to confirm lockfile is in good state
   - If drifts found: fix them before pushing

3. **Push to main and watch CI until ALL gates pass**
   - Use `git push origin main` (ensure you've rebased to avoid non-fast-forward)
   - Watch CI status via GitHub Actions (or equivalent)
   - All required checks must show ✓ (green)
   - Do not assume success from local pass — wait for CI confirmation

4. **Do NOT report success until CI shows green with evidence**
   - Capture CI status screenshot or link showing all gates passing
   - Wait for all workflows to complete (build, test, deploy, etc.)
   - Include actual CI evidence in completion message
   - Never claim "done" based on local pass alone

## Checklist

- [ ] `pnpm gate` passes locally (lint, typecheck, coverage, test, build, migrations)
- [ ] `.env.example` is in sync with codebase env vars
- [ ] `pnpm-lock.yaml` has no drifts (run `pnpm install --frozen-lockfile`)
- [ ] Changes pushed to main via `git push origin main`
- [ ] All GitHub Actions workflows completed
- [ ] All CI checks show ✓ (green)
- [ ] CI evidence captured (screenshot or link)

## Common Failures to Fix

- **Lint warnings**: Fix root cause, don't suppress. Run `pnpm lint --fix` if auto-fixable.
- **Type errors**: Correct type annotations, don't use `any`. Run `pnpm typecheck`.
- **Coverage below threshold**: Add tests to bring coverage above the package's threshold in `vitest.config.ts`.
- **Test failures**: Debug and fix the failing test; don't skip or mock.
- **Migration errors**: Verify migration SQL is correct, runs on target database, is reversible.
- **Build failures**: Check for unused imports, dead code, syntax errors. Run `pnpm build`.
- **Lockfile drift**: Run `pnpm install` to refresh, commit the updated `pnpm-lock.yaml`.

## Integration with CLAUDE.md

This skill operationalizes the "Test gate enforcement — non-negotiable" and "Verification discipline" sections of CLAUDE.md. Use it whenever you need to verify green CI before declaring a task complete or pushing to production.

See CLAUDE.md → "Test gate enforcement" for coverage ratcheting rules and CI gate details.
