/**
 * drizzle.config.ts lists every Postgres schema drizzle-kit may see in
 * `schemaFilter`. A schema declared with `pgSchema()` in ./_schemas.ts but
 * missing from that list is invisible to introspect and push. Its tables then
 * read as absent, and a diff proposes dropping them. This guard fails when the
 * two lists drift apart in either direction (#2972).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PgSchema } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import drizzleConfig from "../../drizzle.config";
import * as schemas from "./_schemas";

const SCHEMAS_SOURCE = readFileSync(
  fileURLToPath(new URL("./_schemas.ts", import.meta.url)),
  "utf8",
);

function declaredSchemaNames(): string[] {
  return (Object.values(schemas) as unknown[])
    .filter((value): value is PgSchema => value instanceof PgSchema)
    .map((schema) => schema.schemaName)
    .sort();
}

function filterSchemaNames(): string[] {
  const filter = (drizzleConfig as { schemaFilter?: string | string[] })
    .schemaFilter;
  if (filter === undefined) return [];
  return (Array.isArray(filter) ? [...filter] : [filter]).sort();
}

describe("drizzle.config.ts schemaFilter", () => {
  it("lists exactly the schemas declared in _schemas.ts", () => {
    expect(filterSchemaNames()).toEqual(declaredSchemaNames());
  });

  it("names each schema once", () => {
    const names = filterSchemaNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("sees every pgSchema() call in _schemas.ts as an export", () => {
    // A pgSchema() call that is not exported would escape the import above
    // and so escape the equality check. The source scan catches it.
    const called = [...SCHEMAS_SOURCE.matchAll(/pgSchema\(\s*"([^"]+)"\s*\)/g)]
      .map((match) => match[1])
      .sort();
    expect(called).toEqual(declaredSchemaNames());
  });
});
