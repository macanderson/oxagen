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
-- The backfill copies each classified record's four columns onto the version
-- its last Context PR merge inserted: the newest version whose provenance
-- names `context_pr`. That is the version the record row's copy was written
-- for, whichever version is pinned today.
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
  "kind" = r."kind",
  "force" = r."force",
  "constraint_effect" = r."constraint_effect",
  "statement" = r."statement"
FROM "agent"."context_records" r
WHERE v."record_id" = r."id"
  AND r."kind" IS NOT NULL
  AND v."kind" IS NULL
  AND v."version_number" = (
    SELECT max(x."version_number")
    FROM "agent"."context_record_versions" x
    WHERE x."record_id" = r."id"
      AND x."provenance" @> '[{"method": "context_pr"}]'::jsonb
  );

COMMENT ON COLUMN "agent"."context_record_versions"."kind" IS
  'The kind the version body declares. Written by merge_context_pr; NULL on a version the legacy publish_context_record path wrote.';
COMMENT ON COLUMN "agent"."context_record_versions"."force" IS
  'How hard the version body steers: must, should, may, or info. NULL on a legacy version.';
COMMENT ON COLUMN "agent"."context_record_versions"."constraint_effect" IS
  'require or forbid when the version is a constraint; NULL otherwise.';
COMMENT ON COLUMN "agent"."context_record_versions"."statement" IS
  'The single-sentence claim the version body makes. NULL on a legacy version.';
