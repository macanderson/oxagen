---
name: iam-missing-migration-silent-defaulteffect-degrade
type: bug
domain: security
severity: P1
linear: OXA-2056
date: 2026-07-04
---

**Symptom:** When the IAM migration had not been applied to a target Postgres database (tables absent → error `42P01`, "relation does not exist"), `fetchAuthz()` (`packages/iam/src/fetch-authz.ts`) logged a `warn` and returned `EMPTY_AUTHZ` for human-session callers, which made the resolver fall through to each contract's `defaultEffect`. Any capability whose `defaultEffect` is `"allow"` was silently granted with zero IAM enforcement — and the only trace was an easy-to-miss `warn` log line. Only API-key callers already failed closed in this situation (via `denyApiKeyAuthz`).

**Root cause:** The 42P01 catch branch treated "IAM tables missing" as a benign dev-environment convenience rather than the "IAM enforcement is silently disabled in prod" incident it actually is, and applied fail-closed handling asymmetrically (API-key path only).

**Fix:**
- Renamed `denyApiKeyAuthz` → `denyAuthz` (same synthetic org-enforced DENY policy shape) and now call it unconditionally on 42P01, for every caller (human session or API key) — never `EMPTY_AUTHZ` on a missing migration.
- Changed the log call from `logger.warn` to `logger.error` with a "SECURITY ALERT" message so it can't be missed / can be alerted on.

**Guard:** `packages/iam/src/fetch-authz.test.ts` — new tests: "fails closed (deny policy, not EMPTY_AUTHZ) for a HUMAN SESSION when Postgres throws 42P01" and "logs the 42P01 fallback at ERROR level (loud alert), not warn" (asserts message matches `/SECURITY ALERT/i` and `/42P01/`, and that `logger.warn` is never called for this path). The old test asserting `EMPTY_AUTHZ` for the human-session 42P01 case was rewritten to assert the new fail-closed policy shape.

**Watch-outs:** `packages/iam/src/fetch-authz.ts`'s module comment still notes "remove this fallback after `pnpm db:migrate` is standard" — the fallback itself (catching 42P01 at all) is still intentional graceful-degradation-of-the-crash, but it must now degrade to deny, never to defaultEffect. Any other IAM/billing resolver that catches a missing-table error and falls back to a default value should get the same treatment: log loudly, fail closed, never silently pick the more permissive default.
