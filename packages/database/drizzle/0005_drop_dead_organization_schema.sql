-- Drop the vestigial `organization` schema. The canonical org schema is `org`
-- (org.organizations) — see 0000_baseline.sql and packages/database/src/schema/
-- _schemas.ts (pgSchema("org")). The empty `organization` schema was created by
-- an older tools/scripts/init-postgres.sql bootstrap and never used: there are
-- zero qualified references to it anywhere in the codebase.
--
-- Guarded drop: only removes the schema when it holds no objects, so this can
-- never destroy data if something was unexpectedly placed there. Idempotent and
-- safe to re-run (the IF-EXISTS check no-ops on a clean DB).
do $$
declare
  obj_count int;
begin
  if exists (
    select 1 from information_schema.schemata where schema_name = 'organization'
  ) then
    select count(*) into obj_count
    from information_schema.tables
    where table_schema = 'organization';
    if obj_count = 0 then
      execute 'drop schema organization cascade';
      raise notice 'dropped empty vestigial schema "organization"';
    else
      raise exception
        'schema "organization" is not empty (% tables present); refusing to drop',
        obj_count;
    end if;
  end if;
end$$;
