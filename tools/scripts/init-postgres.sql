-- Initial Postgres bootstrap. Runs once on container init via
-- docker-entrypoint-initdb.d. Drizzle migrations attach to schemas
-- created here; Better Auth tables land under `auth` per spec §15.4.

create extension if not exists "citext";
create extension if not exists "ltree";
create extension if not exists "pgcrypto";
create extension if not exists "pg_stat_statements";

-- uuid_generate_v7() ships in Postgres 17+. On 16, install via the
-- `pg_uuidv7` extension or fall back to a generated function in
-- migrations. We try the extension; ignore if unavailable so init still
-- succeeds against stock images.
do $$
begin
  begin
    create extension if not exists "pg_uuidv7";
  exception when others then
    raise notice 'pg_uuidv7 unavailable; Drizzle migration will provide a fallback';
  end;
end$$;

-- 14 domain schemas per spec §6. Names must match the canonical set in
-- packages/database/drizzle.config.ts (schemaFilter) and 0000_baseline.sql.
-- The org schema is `org` (org.organizations), NOT `organization`.
create schema if not exists org;
create schema if not exists auth;
create schema if not exists workspace;
create schema if not exists integration;
create schema if not exists agent;
create schema if not exists workflow;
create schema if not exists event;
create schema if not exists execution;
create schema if not exists chat;
create schema if not exists content;
create schema if not exists graph;
create schema if not exists evaluation;
create schema if not exists billing;
create schema if not exists security;
