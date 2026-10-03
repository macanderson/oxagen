-- Every steering record carries a kind and a force (#3296).
--
-- Every write path has required both since #3302: publish_steering_record,
-- merge_steering_pr, and the repository sync all write them. Migration
-- 20260920160000 labelled the older rows that had neither. That migration
-- left the NOT NULL constraint for later, because migrations were then
-- applied by hand on no ordering guarantee against the deploy, and an old
-- container could still have written a row without them. migration-gate now
-- applies migrations before deploy-node ships (#3653), and many deploys have
-- shipped since #3302, so no container still serving traffic predates it.
-- The columns can now say what the code already holds.
--
-- First, label any row that still lacks one. Production should hold none,
-- because every write since #3302 sets both and 20260920160000 backfilled
-- the rows before it. This backfill is a guard, so the constraint below
-- cannot fail the deploy over a row nobody knew about. It sets each column
-- on its own and leaves a value already there:
--
-- - A missing force becomes `info`. A row with no force never reached an
--   agent, and `info` never reaches one either, so no row changes how it
--   steers.
-- - A missing kind becomes `memory`, the label 20260920160000 chose for a
--   record written before classification existed. A row that carries a
--   constraint effect becomes `constraint` instead, because only a
--   constraint carries one, and `memory` would fail
--   steering_records_constraint_effect_check.
--
-- The statement is left alone. A record with no statement still steers
-- nothing, and the run manifest now lists it as cut for `incomplete`.
UPDATE "agent"."steering_records"
SET
  "kind" = coalesce(
    "kind",
    CASE WHEN "constraint_effect" IS NOT NULL THEN 'constraint' ELSE 'memory' END
  ),
  "force" = coalesce("force", 'info')
WHERE "kind" IS NULL OR "force" IS NULL;

ALTER TABLE "agent"."steering_records"
  ALTER COLUMN "kind" SET NOT NULL,
  ALTER COLUMN "force" SET NOT NULL;

COMMENT ON COLUMN "agent"."steering_records"."kind" IS
  'The kind the record''s active version declares: rule, constraint, procedure, fact, memory, or preference. Required on every write since #3302, and NOT NULL since 20261004001000.';
COMMENT ON COLUMN "agent"."steering_records"."force" IS
  'How hard the record steers: must, should, may, or info. Required on every write since #3302, and NOT NULL since 20261004001000.';
