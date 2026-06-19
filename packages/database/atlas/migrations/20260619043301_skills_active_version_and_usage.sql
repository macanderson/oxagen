-- Modify "skills" table
ALTER TABLE "agent"."skills" ADD COLUMN "active_version_id" uuid NULL, ADD COLUMN "activated_by_user_id" uuid NULL, ADD COLUMN "activated_at" timestamptz NULL, ADD COLUMN "last_used_at" timestamptz NULL, ADD COLUMN "usage_count" integer NOT NULL DEFAULT 0, ADD COLUMN "installed_from_slug" public.citext NULL, ADD CONSTRAINT "skills_active_version_id_skill_versions_id_fk" FOREIGN KEY ("active_version_id") REFERENCES "agent"."skill_versions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
-- Backfill: pin each existing skill's active version to its current latest
-- snapshot so active_version_id is populated for rows created before this
-- column existed. Only touches rows that have not been pinned yet.
UPDATE "agent"."skills" AS s
SET "active_version_id" = (
  SELECT sv."id"
  FROM "agent"."skill_versions" AS sv
  WHERE sv."skill_id" = s."id" AND sv."is_latest" = true
  LIMIT 1
)
WHERE s."active_version_id" IS NULL;
