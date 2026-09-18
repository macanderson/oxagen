-- Every person's clock defaults to Pacific time (America/Los_Angeles, so the
-- PST/PDT switch follows the IANA rule rather than a fixed offset). The column
-- shipped defaulting to UTC and nothing in the rebuilt app read it, so every
-- row still at 'UTC' is the untouched default, not a choice: those rows move
-- with the default. A row holding any other zone is a choice and stays.
ALTER TABLE "auth"."user_preferences"
  ALTER COLUMN "timezone" SET DEFAULT 'America/Los_Angeles';

UPDATE "auth"."user_preferences"
  SET "timezone" = 'America/Los_Angeles'
  WHERE "timezone" = 'UTC';
