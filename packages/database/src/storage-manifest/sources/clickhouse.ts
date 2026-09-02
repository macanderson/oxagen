// ClickHouse source — parses CREATE TABLE DDL from the canonical schema.
//
// packages/telemetry/src/migrations/schema.sql is the canonical desired-state
// baseline (migrate.ts re-applies it idempotently before the numbered
// migrations, which are pure ADD COLUMN / CREATE IF NOT EXISTS deltas). Parsing
// the baseline gives every append-only telemetry table with its full column set
// as of the baseline, plus engine / ORDER BY / PARTITION BY / TTL. It is a
// committed file, so parsing it is fully deterministic and needs no live DB.
//
// The parser is intentionally small and tolerant of ClickHouse type syntax
// (nested parens: LowCardinality(String), Nullable(UUID), Map(K,V), CODEC(...)):
// it walks the column list respecting parenthesis depth so a comma inside a
// type never splits a column, and it skips INDEX / CONSTRAINT lines.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ManifestColumn, ManifestTable } from "../types";
import { assignDomain } from "../domains";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the ClickHouse baseline schema. Resolved relative to this
 * module so the generator runs from any cwd. The path is stable in the repo
 * layout (packages/telemetry/src/schema.sql).
 */
export const CLICKHOUSE_SCHEMA_PATH = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "telemetry",
  "src",
  "schema.sql",
);

/** Store-qualified id for a ClickHouse table, e.g. "clickhouse:token_usage". */
export function clickhouseTableId(name: string): string {
  return `clickhouse:${name}`;
}

/** Split a column-body string on top-level commas (depth-0 only). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Strip block/line SQL comments so they never leak into column parsing. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

// A column entry starts with an identifier + a type; INDEX / CONSTRAINT /
// PRIMARY KEY entries are structural, not columns. Column type extends to the
// first top-level keyword we don't model (DEFAULT / CODEC / MATERIALIZED / TTL)
// or end of entry.
const STRUCTURAL_PREFIX = /^(INDEX|CONSTRAINT|PRIMARY\s+KEY|PROJECTION)\b/i;
const TYPE_STOP =
  /\b(DEFAULT|CODEC|MATERIALIZED|ALIAS|EPHEMERAL|TTL|COMMENT)\b/i;

function parseColumn(entry: string): ManifestColumn | null {
  const trimmed = entry.trim();
  if (!trimmed || STRUCTURAL_PREFIX.test(trimmed)) return null;
  // First token is the column name (optionally backtick-quoted).
  const nameMatch = trimmed.match(/^`?([A-Za-z_][A-Za-z0-9_]*)`?\s+([\s\S]+)$/);
  if (!nameMatch || !nameMatch[1] || !nameMatch[2]) return null;
  const name = nameMatch[1];
  const rest = nameMatch[2].trim();
  // Type is everything up to the first modeling-stop keyword. This scan is NOT
  // paren-depth-aware: a stop keyword nested inside a type's parens would end
  // the type early. No ClickHouse type spells DEFAULT/CODEC/TTL/etc. inside its
  // own parens, so the baseline parses correctly today — but a type that did
  // would truncate here rather than error.
  const stop = rest.search(TYPE_STOP);
  const typeStr = (stop >= 0 ? rest.slice(0, stop) : rest).trim();
  // Nullability: ClickHouse columns are non-null unless wrapped in Nullable(...).
  const nullable = /^Nullable\s*\(/i.test(typeStr);
  return {
    name,
    type: typeStr.replace(/\s+/g, " "),
    nullable,
    primaryKey: false, // ClickHouse ORDER BY key is captured in meta, not per-column PK
  };
}

/** Extract a trailing clause value (ENGINE / PARTITION BY / ORDER BY / TTL). */
function extractClause(tail: string, clause: RegExp): string | undefined {
  const m = tail.match(clause);
  return m && m[1] ? m[1].trim().replace(/\s+/g, " ") : undefined;
}

/**
 * Parse a ClickHouse schema.sql string into ManifestTables. Exported pure so it
 * is unit-testable without touching the filesystem. Tables are sorted by id.
 */
export function parseClickhouseSchema(sql: string): ManifestTable[] {
  const clean = stripComments(sql);
  const tables: ManifestTable[] = [];
  // Match: CREATE TABLE [IF NOT EXISTS] <name> ( <body> ) <tail-until-semicolon>
  const re =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z_][A-Za-z0-9_]*)`?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const name = m[1];
    if (!name) continue;
    // Walk from the opening paren to its matching close, respecting depth.
    const open = re.lastIndex - 1;
    let depth = 0;
    let i = open;
    for (; i < clean.length; i++) {
      if (clean[i] === "(") depth++;
      else if (clean[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = clean.slice(open + 1, i);
    // Tail = the clauses between the closing paren and the statement's
    // terminating semicolon. A missing semicolon (unterminated final statement)
    // must clamp to end-of-input; indexOf's -1 would otherwise slice from the
    // end and swallow every following statement into this table's meta.
    const semicolon = clean.indexOf(";", i);
    const tail = clean.slice(
      i + 1,
      semicolon === -1 ? clean.length : semicolon,
    );

    const columns = splitTopLevel(body)
      .map(parseColumn)
      .filter((c): c is ManifestColumn => c !== null);

    const meta: Record<string, string> = {};
    const engine = extractClause(
      tail,
      /ENGINE\s*=\s*([^\n]+?)(?=\s+(?:PARTITION|ORDER|TTL|SETTINGS|PRIMARY)\b|$)/i,
    );
    if (engine) meta.engine = engine;
    const partitionBy = extractClause(
      tail,
      /PARTITION\s+BY\s+([\s\S]+?)(?=\s+(?:ORDER|TTL|SETTINGS|PRIMARY)\b|$)/i,
    );
    if (partitionBy) meta.partitionBy = partitionBy;
    const orderBy = extractClause(
      tail,
      /ORDER\s+BY\s+([\s\S]+?)(?=\s+(?:TTL|SETTINGS|PARTITION)\b|$)/i,
    );
    if (orderBy) meta.orderBy = orderBy;
    const ttl = extractClause(
      tail,
      /\bTTL\s+([\s\S]+?)(?=\s+(?:SETTINGS)\b|$)/i,
    );
    if (ttl) meta.ttl = ttl;

    // Tenant-scoped when the table carries an org_id column — the telemetry
    // tables that are per-org (token_usage, tool_invocations, ...) all key on
    // org_id; the product-eval tables (eval_runs/eval_results) deliberately do
    // not (they measure the product, not a tenant) and are correctly false.
    const tenantScoped = columns.some((c) => c.name === "org_id");

    tables.push({
      id: clickhouseTableId(name),
      store: "clickhouse",
      domain: assignDomain("clickhouse", name),
      name,
      tenantScoped,
      columns,
      meta,
    });
  }
  tables.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tables;
}

/** Read + parse the canonical ClickHouse schema from disk. */
export function collectClickhouseTables(): ManifestTable[] {
  const sql = readFileSync(CLICKHOUSE_SCHEMA_PATH, "utf8");
  return parseClickhouseSchema(sql);
}
