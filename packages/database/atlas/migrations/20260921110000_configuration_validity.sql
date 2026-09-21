-- Modify "agents" table
ALTER TABLE "agent"."agents" ADD COLUMN "valid_until" timestamptz NULL;
-- Modify "context_proposals" table
ALTER TABLE "agent"."context_proposals" ADD COLUMN "title" text NULL;
-- Modify "context_records" table
ALTER TABLE "agent"."context_records" ADD COLUMN "valid_until" timestamptz NULL;

-- Legacy retired identities use updated_at as the best retained end date, not proof of the original retirement time.
UPDATE "agent"."agents" SET "valid_until" = "updated_at" WHERE "status" = 'archived';
UPDATE "agent"."context_records" SET "valid_until" = "updated_at" WHERE "status" IN ('retired', 'superseded');
