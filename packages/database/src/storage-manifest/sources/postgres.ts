// Postgres source — introspects the Drizzle schema objects directly.
//
// This is the robust, typed path the task mandates: Drizzle's getTableConfig()
// exposes each pgTable's schema (domain), name, columns (name / SQL type /
// nullability / pk), and foreign keys programmatically — no SQL parsing, no
// live DB. Tenant-scoping + RLS class come from the tenant-policy manifest
// (the repo's own source of truth for which owned table gets which policy).

import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../../schema/index";
import {
  POLICY_MANIFEST,
  type PolicyClass,
} from "../../tenant-policy.manifest";
import type { ManifestColumn, ManifestTable } from "../types";

/** Store-qualified id for a Postgres table, e.g. "postgres:billing.invoices". */
export function pgTableId(schemaName: string, tableName: string): string {
  return `postgres:${schemaName}.${tableName}`;
}

// schema.table → policy class, for O(1) lookup while introspecting.
const POLICY_BY_TABLE = new Map<string, PolicyClass>(
  POLICY_MANIFEST.map((e) => [e.table, e.policyClass]),
);

/**
 * Introspect every Drizzle pgTable exported from the schema barrel into a
 * sorted list of ManifestTable. Deterministic: tables are sorted by id and
 * columns keep their declared order (Postgres column order is meaningful and
 * stable in the Drizzle object).
 */
export function collectPostgresTables(): ManifestTable[] {
  const tables: ManifestTable[] = [];

  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    // Every domain table lives in an explicit pg schema; the public schema is
    // not used for domain data, so a missing schema name is a hard signal we
    // introspected something unexpected. Default to "public" defensively.
    const schemaName = cfg.schema ?? "public";
    const id = pgTableId(schemaName, cfg.name);
    const policyKey = `${schemaName}.${cfg.name}`;
    const rls = POLICY_BY_TABLE.get(policyKey);

    const columns: ManifestColumn[] = cfg.columns.map((col) => {
      const column: ManifestColumn = {
        name: col.name,
        type: col.getSQLType(),
        nullable: !col.notNull,
        primaryKey: col.primary,
      };
      return column;
    });

    // Foreign keys → per-column `references` (a target table id). A column may
    // back at most one FK in this schema (no composite cross-table FKs), so a
    // flat column→target map is sufficient and stays canonical.
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      const targetCfg = getTableConfig(ref.foreignTable);
      const targetId = pgTableId(targetCfg.schema ?? "public", targetCfg.name);
      for (const localCol of ref.columns) {
        const match = columns.find((c) => c.name === localCol.name);
        if (match) match.references = targetId;
      }
    }

    const table: ManifestTable = {
      id,
      store: "postgres",
      domain: schemaName,
      name: cfg.name,
      // A table is tenant-scoped iff it appears in the tenant-policy manifest —
      // that manifest is the authoritative record of which tables carry RLS
      // tenant isolation. Tables absent from it are shared catalogs or isolate
      // transitively via an FK to a policied parent (see the manifest header).
      tenantScoped: rls !== undefined,
      columns,
    };
    if (rls !== undefined) table.rls = rls;
    tables.push(table);
  }

  tables.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tables;
}
