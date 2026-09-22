-- billing.usage_outbox landed (20260921100000) with the constraint name
-- Postgres invents, "usage_outbox_org_id_fkey", while the Drizzle schema
-- derives "usage_outbox_org_id_organizations_id_fk" for the same key. Atlas
-- compares the two and reads the difference as a rename to apply. Rename it
-- once so the migration directory and the schema agree.
ALTER TABLE "billing"."usage_outbox" RENAME CONSTRAINT "usage_outbox_org_id_fkey" TO "usage_outbox_org_id_organizations_id_fk";

-- The same migration granted oxagen_app its access with a bare GRANT, which
-- fails on a database that has no oxagen_app role (the RDS compatibility job
-- and a fresh local database). The sibling migrations guard the grant on the
-- role's existence. A repeated GRANT changes nothing where the first one
-- applied.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON billing.usage_outbox TO oxagen_app';
  END IF;
END
$$;
