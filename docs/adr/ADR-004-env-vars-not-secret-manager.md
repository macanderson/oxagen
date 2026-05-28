# ADR-004 — Environment variables, not Google Secret Manager

**Date:** 2026-05-28
**Status:** Accepted
**Epic:** Foundations

## Context

Earlier draft of the spec required all secrets to resolve through Google
Secret Manager. Hosting was then re-decided away from GCP (Neon for
Postgres, ClickHouse Cloud, Neo4j AuraDB, Vercel for frontend). With no
GCP footprint elsewhere, GSM no longer fits.

## Decision

Use **environment variables** for the foundations milestone. `.env.local`
is the only secret-bearing file developers create; it is gitignored.
CI uses GitHub Actions Secrets. `packages/config` validates env via Zod
on boot; apps fail closed if a required variable is missing or
malformed.

## Alternatives considered

- **Google Secret Manager.** Required a GCP project just for secrets.
  Workload Identity Federation overhead in CI for a single-vendor
  benefit.
- **Doppler / 1Password Secrets.** Both work, but adds a vendor and a
  fetch step. Deferred to a follow-up when team grows.
- **HashiCorp Vault.** Overkill for a small team.

## Consequences

- `.env.example` at repo root is canonical and gitignore-safe.
- `packages/config/src/env.ts` Zod-validates every variable.
- Per-app `requiredEnv` exports subset the contract.
- Pre-commit hook scans for raw secret values in tracked files.
- CI maps GitHub Actions Secrets to the same names as `.env.example`.
- Tradeoff: rotation is manual via provider dashboards. Documented as a
  follow-up if rotation cadence becomes an issue.
- Future migration: a managed secret store can replace `loadEnv()` in
  `packages/config` without touching app code.
