#!/usr/bin/env tsx
/**
 * Atlas external schema provider.
 *
 * Prepends the Postgres extension + stub-function setup that the dev Docker
 * container needs before the Drizzle-generated DDL. The dev container is
 * ephemeral (Atlas spins it up for diff computation only) and starts without
 * any extensions; `citext`, `uuid-ossp`, and a UUID-v7 stub are required for
 * the schema to parse and apply cleanly.
 *
 * Referenced from atlas.hcl as:
 *   data "external_schema" "drizzle" {
 *     program = ["npx", "tsx", "atlas/provider.ts"]
 *   }
 */
import { execSync } from "node:child_process";

const devSetup = `
-- Extensions required by the Oxagen schema
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Stub for uuid_generate_v7(): falls back to v4 if pg_uuidv7 is not installed.
-- Production databases should have pg_uuidv7; the stub keeps Atlas dev-container
-- diff generation working without it.
CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
RETURNS uuid
LANGUAGE sql
AS $$ SELECT uuid_generate_v4() $$;

`;

const drizzleDDL = execSync("npx drizzle-kit export", {
  encoding: "utf8",
  cwd: process.cwd(),
});

process.stdout.write(devSetup + drizzleDDL);
