-- Every person's clock defaults to Pacific time (America/Los_Angeles, so the
-- PST/PDT switch follows the IANA rule rather than a fixed offset).
ALTER TABLE "auth"."user_preferences"
  ALTER COLUMN "timezone" SET DEFAULT 'America/Los_Angeles';

-- Move the rows still sitting on the old default, and only those.
--
-- 'UTC' alone does not say which it is: the column shipped defaulting to UTC,
-- but `set_preferences` has accepted an explicit 'UTC' over the API and MCP
-- since before this migration, so some UTC rows are a person's choice about
-- how they read every run and audit timestamp. Rewriting those would change
-- what those timestamps mean to them, silently.
--
-- `updated_by_id` separates the two. `set_preferences` is the only writer of
-- this row (ADR-075) and it always stamps the acting principal, on insert and
-- on update alike, so a null there means no person has ever written this row
-- and its timezone is the untouched default. A non-null one is a row someone
-- wrote, and it keeps whatever it holds.
--
-- The remaining imprecision is deliberate and falls the safe way: someone who
-- set an unrelated preference while leaving the timezone alone keeps UTC
-- rather than moving to Pacific. That leaves a person on the old default; the
-- other direction would overwrite a person's stated choice.
UPDATE "auth"."user_preferences"
  SET "timezone" = 'America/Los_Angeles'
  WHERE "timezone" = 'UTC'
    AND "updated_by_id" IS NULL;
