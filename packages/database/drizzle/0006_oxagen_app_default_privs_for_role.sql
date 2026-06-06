-- 0006_oxagen_app_default_privs_for_role.sql
--
-- Forward-fix for 0005_oxagen_app_role.sql (PR review).
--
-- 0005 set `ALTER DEFAULT PRIVILEGES IN SCHEMA … GRANT … TO oxagen_app` without
-- a `FOR ROLE` clause, so the default privileges attach only to objects created
-- by whatever role ran 0005. That role is implicit (the session role), so if a
-- later migration is run by a DIFFERENT database user (CI user rotation, a
-- managed-DB IAM user change), tables it creates would silently NOT be granted
-- to oxagen_app — breaking RLS-enforced reads/writes with no loud error.
--
-- 0005 is immutable (already applied), so we fix forward: re-issue the default
-- privileges with an explicit `FOR ROLE <current migrator>` to make the
-- dependency visible, and re-GRANT on all CURRENT tables/sequences as a belt-and
-- -suspenders resync. ALTER DEFAULT PRIVILEGES and GRANT are idempotent, so this
-- is safe to (re-)run. NOTE: default privileges are inherently per-creating-role
-- in Postgres — full robustness against role rotation means re-running this
-- resync (or `provision-rls-role.ts`) after any migrator-role change; this
-- migration pins the dependency for the role in effect when it is applied.

SET search_path TO public;

DO $$
DECLARE
  s text;
  migrator text := current_user;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'org','auth','workspace','integration','agent','workflow',
    'event','execution','chat','content','graph','evaluation',
    'billing','security'
  ]
  LOOP
    -- Resync grants on existing objects (idempotent).
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO oxagen_app', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO oxagen_app', s);
    -- Explicit FOR ROLE so the dependency on the migrating role is visible.
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oxagen_app', migrator, s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO oxagen_app', migrator, s);
  END LOOP;

  -- public: function EXECUTE default, FOR ROLE pinned.
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO oxagen_app', migrator);
END $$;
