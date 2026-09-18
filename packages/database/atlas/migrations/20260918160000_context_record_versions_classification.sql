-- Give each context record version its own classification.
--
-- `merge_context_pr` writes a record's classification (kind, force,
-- constraint_effect, statement) onto the record row and pins the version it
-- just inserted. The version row carried only the TOML body. When an operator
-- later promoted an older version back into service, `promote_context_record`
-- moved `active_version_id` and left the four classification columns as the
-- newer merge had set them, so the steering text compiled for the policy
-- bundle described a version that was no longer the pinned one (#3312).
--
-- A classification describes a body, and a body does not change with the
-- record's lineage. So the four columns now live on the version too. The merge
-- writes them on both rows, a promote copies the pinned version's four onto
-- the record row, and the bundle compiler reads them from the pinned version,
-- falling back to the record row only for a version that has none.
--
-- All four are nullable. A version the legacy `publish_context_record` path
-- wrote carries only the body and has NULL in each of them, and the check
-- constraints match the record table's so the two copies cannot disagree on
-- vocabulary.
--
-- The backfill reads each version's own classification from the proposal that
-- merged it. Copying the record row's four columns instead would only be right
-- for one version -- whichever the row was last written for -- and would leave
-- every other version NULL, so promoting an older one would fall back to that
-- same stale row and reproduce #3312. A version whose proposal is gone, and
-- every version the legacy `publish_context_record` path wrote, stays NULL and
-- keeps the record-row fallback `classificationOf` already applies.
--
-- The proposal is found through the promotion ledger, NOT through the version's
-- `provenance`. `publish_context_record` takes provenance from the caller with
-- `method` and `by` as free strings, so a version can claim
-- `{"method":"context_pr","by":"<any proposal public id>"}` and public ids are
-- unique across the platform, not per tenant. Matching on that string would let
-- a caller copy another workspace's -- or another ORGANISATION's -- proposal
-- classification onto their own version, and the reconciliation below would
-- then push that statement onto the record row and into the steering bundle
-- their agents run under (discussion_r4050657642).
--
-- `proposals.promotion_event_id` and `promotions.version_id` are both written
-- by `publishMerge` and by nothing a caller controls, so the chain
-- version <- promotion <- proposal names the one proposal that actually emitted
-- this version. Both hops are fenced on org and workspace as well, so a forged
-- id cannot cross a tenant boundary even if the ledger were wrong.
ALTER TABLE "agent"."context_record_versions"
  ADD COLUMN IF NOT EXISTS "kind" text NULL,
  ADD COLUMN IF NOT EXISTS "force" text NULL,
  ADD COLUMN IF NOT EXISTS "constraint_effect" text NULL,
  ADD COLUMN IF NOT EXISTS "statement" text NULL;

ALTER TABLE "agent"."context_record_versions"
  ADD CONSTRAINT "context_record_versions_kind_check" CHECK ((kind IS NULL) OR (kind = ANY (ARRAY['rule'::text, 'constraint'::text, 'procedure'::text, 'fact'::text, 'memory'::text, 'preference'::text]))),
  ADD CONSTRAINT "context_record_versions_force_check" CHECK ((force IS NULL) OR (force = ANY (ARRAY['must'::text, 'should'::text, 'may'::text, 'info'::text]))),
  ADD CONSTRAINT "context_record_versions_constraint_effect_check" CHECK (((constraint_effect IS NULL) AND (kind IS DISTINCT FROM 'constraint'::text)) OR ((constraint_effect = ANY (ARRAY['require'::text, 'forbid'::text])) AND (kind = 'constraint'::text)));

UPDATE "agent"."context_record_versions" v
SET
  "kind" = p."kind",
  "force" = p."force",
  "constraint_effect" = p."constraint_effect",
  "statement" = p."statement"
FROM "agent"."context_proposals" p
JOIN "agent"."context_promotions" pr ON pr."id" = p."promotion_event_id"
WHERE v."kind" IS NULL
  AND pr."version_id" = v."id"
  AND pr."org_id" = v."org_id"
  AND pr."workspace_id" = v."workspace_id"
  AND p."org_id" = v."org_id"
  AND p."workspace_id" = v."workspace_id";

-- Then reconcile the record rows with the versions they pin.
--
-- Before this change a promote never copied a classification onto the record
-- row, so any record whose pin was moved to an older version carries whatever
-- the last merge left there. Backfilling the versions alone fixes the steering
-- bundle, which reads the pinned version -- but `list_context_records` returns
-- and FILTERS on the record row (`context.steering.store.ts` `listRecords`), so
-- without this those records stay mis-classified on that surface for good. No
-- later promote repairs it either: the row is only rewritten when someone
-- promotes again, which nothing guarantees (discussion_r4050626908).
--
-- Only rows that actually disagree are touched, and only where the pinned
-- version carries a classification: a record pinning a legacy version has
-- nothing better to copy, so its row keeps what it has. The four move together,
-- so the record table's `constraint_effect` check cannot be left unsatisfied --
-- the version table carries the same check.
UPDATE "agent"."context_records" r
SET
  "kind" = v."kind",
  "force" = v."force",
  "constraint_effect" = v."constraint_effect",
  "statement" = v."statement"
FROM "agent"."context_record_versions" v
WHERE v."id" = r."active_version_id"
  AND v."kind" IS NOT NULL
  AND (
    r."kind" IS DISTINCT FROM v."kind"
    OR r."force" IS DISTINCT FROM v."force"
    OR r."constraint_effect" IS DISTINCT FROM v."constraint_effect"
    OR r."statement" IS DISTINCT FROM v."statement"
  );

COMMENT ON COLUMN "agent"."context_record_versions"."kind" IS
  'The kind the version body declares. Written by merge_context_pr; NULL on a version the legacy publish_context_record path wrote.';
COMMENT ON COLUMN "agent"."context_record_versions"."force" IS
  'How hard the version body steers: must, should, may, or info. NULL on a legacy version.';
COMMENT ON COLUMN "agent"."context_record_versions"."constraint_effect" IS
  'require or forbid when the version is a constraint; NULL otherwise.';
COMMENT ON COLUMN "agent"."context_record_versions"."statement" IS
  'The single-sentence claim the version body makes. NULL on a legacy version.';
