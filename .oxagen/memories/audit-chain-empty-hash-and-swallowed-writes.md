---
name: audit-chain-empty-hash-and-swallowed-writes
type: bug
domain: security
severity: P2
linear: OXA-2058
date: 2026-07-04
---

**Symptom:** Two SOC2-relevant silent-failure defects in the audit surfaces:
1. `recordSecurityEvent`/`recordSecurityEventAsync` (`packages/telemetry/src/security.ts`, backing `emitSecurityEvent` in `packages/database/src/security.ts`) caught every DB write failure on the first attempt and only wrote a single structured line to `process.stderr` — no retry, no durable/alertable signal. A dropped security-audit row (auth changes, permission grants, capability denies) was invisible.
2. `emitAudit()` (`packages/iam/src/emit-audit.ts`) computes a SHA-256 tamper-evident `chain_hash` for the ClickHouse `audit_events` table. When `sha256Hex()` threw (payload hash OR chain hash), the code caught it and fell back to persisting `chain_hash: ""` — an empty link that breaks tamper-evidence for every subsequent row chained on top of it.

**Root cause:** Both functions treated "fire-and-forget" as license to swallow-and-degrade rather than swallow-and-alert. The chain-hash fallback additionally confused "the write must never block the caller" with "the write may be silently corrupted" — those are not the same requirement.

**Fix:**
- Added `packages/telemetry/src/retry.ts` (`retryWithBackoff`, 3 attempts/exponential backoff by default). `recordSecurityEvent`/`recordSecurityEventAsync` now retry before giving up, and on exhaustion call `captureError()` (ClickHouse `error_events` + optional alert webhook) in addition to the existing stderr/`onError` path — a dropped write is now durably observable, not just locally logged.
- `emit-audit.ts`: `sha256Hex()` failures for **either** `payloadHash` or `chainHash` now propagate (reject) instead of degrading to `""` — `emitAudit()` refuses to persist any row when a hash can't be computed. The insert itself (`insertAuditEvent`) is also wrapped in `retryWithBackoff` before a failure propagates.
- `check-iam.ts`: both `emitAudit(...).catch()` sites now also call `captureError()` (not just `logger.error`), so a refused/failed audit emission is observable via ClickHouse.

**Important distinction preserved on purpose:** a failure to **read** the previous `chain_hash` (`latestAuditChainHash` throwing) is NOT the same defect and was left non-fatal — it re-anchors the chain from an empty `prevHash` but still **computes and persists a valid, non-empty** `chain_hash`. This is a documented, accepted race (see "HASH-CHAIN RACE" comment in emit-audit.ts, plan.md Phase 3 §Risks) — the OXA-2058 bug only fires when the hash **computation itself** throws.

**Guard:** `packages/telemetry/src/security.test.ts` (retry-then-escalate, retry-then-succeed), `packages/telemetry/src/retry.test.ts` (retry helper itself), `packages/iam/src/emit-audit.test.ts` (rejects + `insertAuditEvent` never called when either hash computation fails; retries the durable insert before propagating), `packages/iam/src/check-iam.test.ts` (`captureError` called on emitAudit rejection, both call sites).

**Watch-outs:** `security_events` (Postgres) has NO `chain_hash` column at all — the tamper-evident hash chain only exists on the ClickHouse `audit_events` table written by `@oxagen/iam`'s `emitAudit()`. Don't assume the two audit surfaces (`security.security_events` vs `audit_events`) share the same integrity guarantees; they're deliberately different systems for different scopes (compliance evidence vs per-capability-invocation tamper chain).
