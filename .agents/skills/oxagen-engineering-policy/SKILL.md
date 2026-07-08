---
name: oxagen-engineering-policy
description: Binding engineering law for the Oxagen monorepo — the non-negotiables every coding agent must follow. Consult BEFORE writing or changing code, choosing or pinning a dependency, designing a schema or migration, writing tests, opening a PR, or touching CI/CD. Covers the prime directives, the four-store data model (Postgres / Neo4j / ClickHouse / file storage), SQL conventions (UUID id + public_id, soft-delete rules), code & schema bloat avoidance, vendor-neutrality, file naming & monorepo layout, observability/instrumentation, PR discipline, brand voice, and performance. This file is law: when a request conflicts with a rule here, halt and surface the conflict instead of weakening the rule.
---

# Oxagen engineering policy

Binding rules for any coding agent operating in this monorepo. **This is law.**
When a request conflicts with a rule here, stop and surface the conflict instead
of drifting. Do not weaken a rule to make a task easier. The detailed sections
live under `policies/`; read the one relevant to your change before editing.

## 0. Non-negotiables (never traded away, never deferred)

A change that violates any of these does not merge — halt and surface the conflict.

- **Compliance from day one.** SOC 2 compliant at all times, never retrofitted; architecture and data handling also meet PCI DSS, GDPR, and HIPAA. Design as if an auditor is reading every decision.
- **Encryption at rest, always.** All persisted data encrypted at rest, no exceptions. Secrets never committed, logged, or stored in plaintext.
- **Strict types everywhere.** No `any`, no implicit `any`, no untyped boundaries. No `# type: ignore` without a justification comment and a tracking issue. Every signature, return value, and public surface fully typed.
- **Zero warnings, zero errors, ever.** Linters, type checkers, compilers, and test runners all green. A warning is an error.
- **Pinned versions.** All dependency versions pinned exactly for reproducible builds — no floating ranges.
- **Logging + instrumentation** everywhere it makes sense, at the right level, through the shared analytics package (§9).
- **Thin wrappers only.** API, CLI, and MCP services are thin shells over shared `packages/`; business logic never reproduced in a service (§7).
- **UI Capability Parity.** A capability that is invocable on any non-`app` surface (api / mcp / cli) and is meant to be operated by a human MUST have real, working UI in `apps/app` that invokes it — proven against a non-erroring page. Declaring the `app` layer in a contract is a binding promise: it requires a `apps/app/capability-ui-map.json` binding pointing at an existing `page` plus a runtime `proof` (screenshot under `verifications/<session>/` or an e2e spec). A missing or broken app surface is as merge-blocking as a missing API route. Enforced by `pnpm check:ui-parity` (forward gate `--strict`; reverse advisory), wired into `pnpm gate`. This is the app-surface twin of the capability-parity rule.
- **Domain-layer organization, always.** Never a flat `models/` or `routes/` folder (§7).
- **Versioned API.** Every endpoint is versioned (§7).
- **Mobile-first.** Thumb-navigable interfaces outrank desktop (§9).

## 0.5 Prime directives

- **Move the rock forward.** Every PR lands a complete, working vertical slice. No placeholders, no `TODO` stubs, no `NotImplementedError`, no commented-out scaffolding "for later."
- **Finish what you touch.** If a change spans schema, API, frontend, tests, and docs, all layers ship in the same PR or it does not merge.
- **No drift.** Policies are not suggestions to trade away under time pressure. If you cannot satisfy one, halt, report why, and propose the smallest compliant alternative.
- **Prefer deleting code to adding it.** The best PR removes more than it adds while delivering the same capability.

## Data storage — four stores, one job each

Pick the store by the nature of the data, never by convenience. Never spread one
concern across stores; never invent a fifth. Ask, in order:

1. **File or blob?** → File storage, with a reference row in Postgres.
2. **Required for the app to function / transactional / relational state?** → **Postgres (AlloyDB)** — system of record, and the relational + vector store.
3. **Agent memory, observation, lesson, or run history a customer would own and carry away?** → **Neo4j** — the portable knowledge graph (never load-bearing for core app function; the app runs with an empty/BYO graph).
4. **High-volume telemetry / analytics for aggregate querying?** → **ClickHouse** — append-only, never a source of truth.

Avoid dual writes. If a mirror is truly required, justify it in the SPEC and drive
it from a single authoritative write via an idempotent, one-directional projection.
Full detail and the SQL conventions (UUID `id` + user-friendly `public_id`,
soft-delete only where it earns its place) are in `policies/0-prime-directives.md`.

## The policy files

Read all of them; they are one body of law split for navigation, not priority.

- [`0-prime-directives.md`](policies/0-prime-directives.md) — non-negotiables, prime directives, data storage, SQL conventions (read first)
- [`1-package-and-version-selection.md`](policies/1-package-and-version-selection.md) — choosing & pinning dependencies
- [`2-vendor-lock-in-avoidance.md`](policies/2-vendor-lock-in-avoidance.md) — adapter seams, portability
- [`3-code-bloat-avoidance.md`](policies/3-code-bloat-avoidance.md) — solve once, delete dead code
- [`3-5-code-simplification.md`](policies/3-5-code-simplification.md) — simplification passes
- [`4-schema-bloat-avoidance.md`](policies/4-schema-bloat-avoidance.md) — no reflexive lifecycle columns
- [`5-migration-patterns.md`](policies/5-migration-patterns.md) — safe, reversible migrations
- [`6-testing-policy.md`](policies/6-testing-policy.md) — real assertions, no stubbed/skipped tests
- [`7-file-naming-and-monorepo-organization.md`](policies/7-file-naming-and-monorepo-organization.md) — domain-layer layout, thin services, naming
- [`8-documentation-policy.md`](policies/8-documentation-policy.md) — what to document and where
- [`9-observability-instrumentation-and-production-readiness.md`](policies/9-observability-instrumentation-and-production-readiness.md) — logging, instrumentation, mobile-first
- [`10-pr-discipline.md`](policies/10-pr-discipline.md) — one ticket = one PR, complete slices
- [`11-brand-voice-policy.md`](policies/11-brand-voice-policy.md) — copy & voice rules
- [`12-ci-cd.md`](policies/12-ci-cd.md) — CI gating, branch protection
- [`13-performance-policy.md`](policies/13-performance-policy.md) — performance budgets & patterns

Related skills: **frontend-patterns** (web-platform technique library).
