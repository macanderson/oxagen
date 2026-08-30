/**
 * Shared test helpers for Drizzle query-chunk inspection.
 * Used by schema-append-only.test.ts and iam-schema.test.ts.
 */

import { getTableConfig } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Internal types for Drizzle query chunk inspection
// ---------------------------------------------------------------------------

export interface SqlLiteralChunk {
  value: string[];
}

export interface ColumnRefChunk {
  name: string;
}

export type QueryChunk = SqlLiteralChunk | ColumnRefChunk | unknown;

export interface DrizzleCheck {
  name: string;
  value: {
    queryChunks?: QueryChunk[];
  };
}

// ---------------------------------------------------------------------------
// Helper: flatten queryChunks into a single inspectable SQL string.
//
// Drizzle stores CHECK SQL as a tree of queryChunk objects:
//   - Column refs: { name: string, ... }
//   - SQL literals: { value: string[] }
//   - Nested SQL (e.g. sql.raw(...)): { queryChunks: QueryChunk[] }
//
// We recurse into nested queryChunks so that sql.raw(...) values are included.
// ---------------------------------------------------------------------------

export function flattenCheckSql(check: DrizzleCheck): string {
  return flattenChunks(check.value.queryChunks ?? []);
}

function flattenChunks(chunks: QueryChunk[]): string {
  return chunks
    .map((chunk) => {
      if (chunk === null || typeof chunk !== "object") return "";
      const c = chunk as Record<string, unknown>;
      // Column reference: carries a `name` property (SQL column name).
      if (typeof c["name"] === "string") return c["name"];
      // SQL literal: carries a `value` array of string fragments.
      if (Array.isArray(c["value"])) {
        return (c["value"] as unknown[])
          .filter((v): v is string => typeof v === "string")
          .join("");
      }
      // Nested SQL object (e.g. sql.raw(...)): recurse into its queryChunks.
      if (Array.isArray(c["queryChunks"])) {
        return flattenChunks(c["queryChunks"] as QueryChunk[]);
      }
      return "";
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Helper: collect SQL column names from a table via getTableConfig.
// ---------------------------------------------------------------------------

export function sqlColumnNames(
  table: Parameters<typeof getTableConfig>[0],
): string[] {
  return getTableConfig(table).columns.map((col) => col.name);
}

// ---------------------------------------------------------------------------
// Helper: collect CHECK constraints from a table via getTableConfig.
// ---------------------------------------------------------------------------

export function getChecks(
  table: Parameters<typeof getTableConfig>[0],
): DrizzleCheck[] {
  return getTableConfig(table).checks as DrizzleCheck[];
}
