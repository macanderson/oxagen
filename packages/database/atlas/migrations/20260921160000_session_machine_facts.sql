-- Modify "sessions" table
ALTER TABLE "tacho"."sessions" ADD COLUMN "machine_snapshot" jsonb NULL;
