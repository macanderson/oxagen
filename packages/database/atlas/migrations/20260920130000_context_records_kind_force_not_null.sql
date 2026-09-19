-- publish_context_record wrote only a record's body, leaving kind, force,
-- constraint_effect and statement NULL on both agent.context_records and
-- agent.context_record_versions. readWorkspaceSteering (ADR-091 section 1)
-- only ever delivers a record whose force is must or should, so a record
-- published that way sat active in the registry and never reached an
-- agent -- and nothing told the publisher (#3302).
--
-- publish_context_record now requires kind, force and statement (and
-- constraint_effect when kind is constraint) on every call, so no future
-- write to context_records can leave kind or force NULL. This backfills the
-- rows a prior, permissive call already wrote and tightens the record
-- table's check constraints to match.
--
-- A pre-existing NULL row was written before classification existed at all,
-- so there is no real kind or force to recover for it: inventing one (a
-- rule? a must?) would assert something the publisher never actually said.
-- `memory` / `info` is the honest label instead -- "recorded, not governed,
-- not a directive" is what publish_context_record actually promised before
-- this migration, and `info` already sits outside must/should, so backfilling
-- to it changes no row's steering behaviour. It only makes visible, as a real
-- kind and force on the row, what was already true: this record never
-- steered anything.
UPDATE "agent"."context_records"
SET
  "kind" = 'memory',
  "force" = 'info',
  "statement" = coalesce("statement", "title")
WHERE "kind" IS NULL OR "force" IS NULL;

ALTER TABLE "agent"."context_records"
  ALTER COLUMN "kind" SET NOT NULL,
  ALTER COLUMN "force" SET NOT NULL;

ALTER TABLE "agent"."context_records"
  DROP CONSTRAINT "context_records_kind_check",
  DROP CONSTRAINT "context_records_force_check";

ALTER TABLE "agent"."context_records"
  ADD CONSTRAINT "context_records_kind_check"
    CHECK ("kind" = ANY (ARRAY['rule'::text, 'constraint'::text, 'procedure'::text, 'fact'::text, 'memory'::text, 'preference'::text])),
  ADD CONSTRAINT "context_records_force_check"
    CHECK ("force" = ANY (ARRAY['must'::text, 'should'::text, 'may'::text, 'info'::text]));

-- agent.context_record_versions keeps its four classification columns
-- nullable (migration `20260918160000`): a version is an immutable record of
-- a body as it was written, and a version the legacy publish_context_record
-- path wrote genuinely has no classification of its own -- that migration's
-- comment already documents this as the deliberate, permanent shape for a
-- legacy version, with the record row (now always classified) as its
-- fallback. This migration does not touch that table; it only closes the
-- live record row, which the registry, list_records and the Steering page
-- all read.
COMMENT ON COLUMN "agent"."context_records"."kind" IS
  'The kind the record''s active version declares. NOT NULL since migration 20260920130000 (#3302); every write path requires one.';
COMMENT ON COLUMN "agent"."context_records"."force" IS
  'How hard the record steers: must, should, may, or info. NOT NULL since migration 20260920130000 (#3302); only must/should ever reach an agent.';
