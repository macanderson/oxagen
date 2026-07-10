-- Race-safe dedupe for JIT access requests (follow-up to OXA-1390 / PR #848).
--
-- createAccessRequest() (packages/iam/src/access-request.ts) mints a row on
-- every pending_approval denial. Its dedupe was an app-side SELECT-then-INSERT,
-- which is not atomic: two concurrent denials for the same
-- (org, requester, capability, scope) can both pass the SELECT and each INSERT
-- a duplicate 'pending' row. Close the race with a DB-enforced partial unique
-- index; createAccessRequest() now retries on the resulting 23505 by
-- re-selecting the surviving row instead of relying solely on the pre-check.
--
-- Before adding the index, collapse any duplicate pending rows that already
-- exist from the unsafe window: keep the oldest pending row per group and
-- mark the rest 'expired' (a value already permitted by
-- access_requests_status_check, so no constraint change is needed — a
-- superseded duplicate no longer represents a live request).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY org_id, requester_id, capability_id, scope_kind, scope_id
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM "iam"."access_requests"
  WHERE status = 'pending'
)
UPDATE "iam"."access_requests" ar
SET status = 'expired', updated_at = now()
FROM ranked
WHERE ar.id = ranked.id AND ranked.rn > 1;

-- Create index "access_requests_pending_dedupe_idx" to table: "access_requests"
CREATE UNIQUE INDEX "access_requests_pending_dedupe_idx" ON "iam"."access_requests" ("org_id", "requester_id", "capability_id", "scope_kind", "scope_id") WHERE (status = 'pending');
