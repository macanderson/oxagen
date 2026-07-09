---
name: webhook-connector-secret-comparison-not-constant-time
type: bug
domain: connectors
severity: P2
linear: OXA-2051
date: 2026-07-04
---

**Symptom:** OXA-2051 described `apps/api/src/routes/v1/webhook.ts` failing OPEN
(`verifyWebhook?.(...) ?? true`), Google Drive/Calendar/Gmail with no
`verifyWebhook` at all, Microsoft always returning `true`, and Slack/Linear's
`timingSafeEqual` throwing uncaught on length mismatch.

**Root cause (audit finding):** by the time this ticket was picked up, the
entire fail-open surface described in the ticket had already been fixed by an
earlier pass (PR #75 "Fix/silent failures critical high", commit `e12a9713`,
merged 2026-06-20) plus follow-on work: `webhook.ts` now explicitly rejects
(401) when `typeof connector.verifyWebhook !== "function"`, rejects (500) when
HMAC-secret decryption throws, and Google Drive/Calendar/Gmail all implement
`verifyWebhook` via a shared `verifyGoogleChannelToken` helper. Slack/Linear/
GitHub/custom-webhook all wrap `timingSafeEqual` in try/catch and return
`false` on the RangeError from a length mismatch. `registry.test.ts` even
enforces "every webhook-delivery connector implements verifyWebhook" as a
regression guard.

However, auditing every connector's comparison logic (not just the ones named
in the ticket) turned up a **co-located instance of the same defect class**:
Zoom's `verifyWebhook` (`packages/ingestion/src/connectors/zoom/index.ts`)
compared the `Authorization` header to the stored secret with a plain
`auth === secret`, and Microsoft's clientState check
(`packages/ingestion/src/connectors/microsoft/index.ts`) compared
`clientState === secret` the same way. Both are on the same unauthenticated
`/webhooks/:connectorId/:connectionId` boundary as the HMAC comparisons — a
plain string `===` is a variable-time comparison and leaks the correct secret
byte-by-byte via response-time analysis, the same class of weakness the
ticket's Slack/Linear bullet was guarding against.

**Fix:** added `packages/ingestion/src/connectors/safe-compare.ts` exporting
`constantTimeStringEqual(a, b)` — length-checks first (fails closed on
mismatch, never throws), then compares via `node:crypto` `timingSafeEqual`
inside a try/catch. Wired it into Zoom's bearer-token check and Microsoft's
clientState check, replacing both `===` comparisons.

**Guard:** `packages/ingestion/src/connectors/__tests__/safe-compare.test.ts`
(new) asserts equal/unequal/length-mismatch cases never throw and fail closed.
`zoom.test.ts` and `microsoft.test.ts` each gained a
"rejects a mismatched-length secret without throwing" regression test that
fails on the old `===` code path is actually fine functionally (it never threw
either) but exists to lock in the constant-time comparison going forward and
catch any future regression back to `===`.

**Watch-outs:** any new webhook connector's `verifyWebhook` must (1) exist —
enforced by `registry.test.ts` — and (2) compare secrets via
`constantTimeStringEqual`, not `===` or `timingSafeEqual` called directly
without a length guard. Prefer importing the shared helper over re-deriving
the try/catch pattern per connector (five connectors currently have their own
copy of the try/catch-around-timingSafeEqual idiom inline; only Zoom and
Microsoft were migrated to the shared helper in this pass since those were the
only two with the actual `===` defect — the others already fail closed, just
with duplicated logic).
