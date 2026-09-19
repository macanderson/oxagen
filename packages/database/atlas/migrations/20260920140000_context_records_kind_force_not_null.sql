-- publish_context_record wrote only a record's body, leaving kind, force,
-- constraint_effect and statement NULL on both agent.context_records and
-- agent.context_record_versions. readWorkspaceSteering (ADR-091 section 1)
-- only ever delivers a record whose force is must or should, so a record
-- published that way sat active in the registry and never reached an
-- agent -- and nothing told the publisher (#3302).
--
-- publish_context_record now requires kind, force and statement (and
-- constraint_effect when kind is constraint) on every call, so no future
-- write from the deployed handler leaves kind or force NULL. This
-- migration backfills the rows a prior, permissive call already wrote.
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

-- Codex P1 on #3486 (round 3): this migration is applied by the manual
-- db-migrate.yml workflow, on no ordering guarantee against deploy-node
-- (which ships the code requiring kind/force on every write) -- an operator
-- running the migration workflow first, or a rolling deploy that still has
-- an old container serving traffic, would hit a NOT NULL violation on
-- every publish from the code that has not shipped yet. The write-side
-- requirement is enforced today at the application layer
-- (packages/oxagen/src/contracts/context.record.publish.ts's schema); a
-- follow-up migration adds ALTER COLUMN ... SET NOT NULL once this
-- handler has been the only writer in production for a full deploy cycle,
-- the same two-step (ship the writer, harden the column later) ADR-111
-- used for measureDeclarationSchema's write boundary.
COMMENT ON COLUMN "agent"."context_records"."kind" IS
  'The kind the record''s active version declares. Every write path requires one since #3302; the NOT NULL constraint is a deliberate follow-up migration (see 20260920140000''s comment).';
COMMENT ON COLUMN "agent"."context_records"."force" IS
  'How hard the record steers: must, should, may, or info. Every write path requires one since #3302; only must/should ever reach an agent. The NOT NULL constraint is a deliberate follow-up migration (see 20260920140000''s comment).';
