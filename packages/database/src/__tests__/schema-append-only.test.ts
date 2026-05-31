/**
 * Schema smoke tests for @oxagen/database.
 *
 * These tests operate entirely on the TypeScript/Drizzle table definitions
 * via `getTableConfig` — no live DB, no network, no random/wall-clock values.
 *
 * Policy assertions:
 *
 *  1. Append-only tables (usage_records, credit_ledger, stripe_events,
 *     security_events) must NOT carry updated_at or deleted_at columns.
 *     Presence of those columns would allow mutation/soft-delete of immutable
 *     audit rows — a SOC2 compliance violation.
 *
 *  2. credit_balances must have a "balance_cents >= 0" CHECK constraint (the
 *     no-overdraft floor). The constraint name must contain
 *     "balance_non_negative" and the SQL expression must reference
 *     "balance_cents" and ">= 0".
 *
 *  3. credit_ledger must have a "delta_cents <> 0" CHECK constraint (a
 *     zero-delta entry is a logic error that pollutes the audit trail). The
 *     constraint name must contain "delta_non_zero" and the SQL expression
 *     must reference "delta_cents" and "<>".
 *
 * Implementation note on queryChunks:
 *   Drizzle 0.45.x stores each CHECK constraint's SQL expression as a
 *   SQL object whose `.queryChunks` array interleaves:
 *     - plain-SQL objects: { value: string[] } — the literal SQL fragments
 *     - column-reference objects: { name: string, ... } — the column
 *   We walk chunks and collect (a) literal strings from `.value[]` and (b)
 *   column names from `.name`, then join into a single string for matching.
 */

import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  usageRecords,
  creditLedger,
  stripeEvents,
  securityEvents,
  creditBalances,
} from "../schema/index.js";
import { flattenCheckSql, sqlColumnNames, type DrizzleCheck } from "./_test-helpers.js";

// ---------------------------------------------------------------------------
// 1. Append-only tables: must have no updated_at or deleted_at columns
// ---------------------------------------------------------------------------

const FORBIDDEN_COLS = ["updated_at", "deleted_at", "updated_by_user_id", "deleted_by_user_id"];

describe("append-only tables: forbidden mutation columns", () => {
  const appendOnlyTables: Array<[string, Parameters<typeof getTableConfig>[0]]> = [
    ["usage_records", usageRecords],
    ["credit_ledger", creditLedger],
    ["stripe_events", stripeEvents],
    ["security_events", securityEvents],
  ];

  for (const [tableName, table] of appendOnlyTables) {
    it(`${tableName} has no updated_at or deleted_at column`, () => {
      const cols = sqlColumnNames(table);
      for (const forbidden of FORBIDDEN_COLS) {
        expect(cols, `${tableName} must not have SQL column "${forbidden}"`).not.toContain(
          forbidden,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. credit_balances: balance_cents >= 0 CHECK constraint
// ---------------------------------------------------------------------------

describe("credit_balances CHECK constraints", () => {
  const cfg = getTableConfig(creditBalances);
  const checks = cfg.checks as DrizzleCheck[];

  it("has a balanceCents column (SQL: balance_cents)", () => {
    const cols = sqlColumnNames(creditBalances);
    expect(cols).toContain("balance_cents");
  });

  it("CHECK constraint name includes 'balance_non_negative'", () => {
    const names = checks.map((c) => c.name);
    expect(
      names.some((n) => n.includes("balance_non_negative")),
      `Expected a CHECK named "..._balance_non_negative" but found: [${names.join(", ")}]`,
    ).toBe(true);
  });

  it("balance_non_negative CHECK SQL references balance_cents and >= 0", () => {
    const target = checks.find((c) => c.name.includes("balance_non_negative"));
    expect(target, "balance_non_negative CHECK not found").toBeDefined();

    const sql = flattenCheckSql(target!);
    expect(sql, `CHECK SQL was: "${sql}"`).toMatch(/balance_cents/);
    expect(sql, `CHECK SQL was: "${sql}"`).toMatch(/>=/);
    expect(sql, `CHECK SQL was: "${sql}"`).toMatch(/0/);
  });
});

// ---------------------------------------------------------------------------
// 3. credit_ledger: delta_cents <> 0 CHECK constraint
// ---------------------------------------------------------------------------

describe("credit_ledger CHECK constraints", () => {
  const cfg = getTableConfig(creditLedger);
  const checks = cfg.checks as DrizzleCheck[];

  it("has a deltaCents column (SQL: delta_cents)", () => {
    const cols = sqlColumnNames(creditLedger);
    expect(cols).toContain("delta_cents");
  });

  it("CHECK constraint name includes 'delta_non_zero'", () => {
    const names = checks.map((c) => c.name);
    expect(
      names.some((n) => n.includes("delta_non_zero")),
      `Expected a CHECK named "..._delta_non_zero" but found: [${names.join(", ")}]`,
    ).toBe(true);
  });

  it("delta_non_zero CHECK SQL references delta_cents and <> 0", () => {
    const target = checks.find((c) => c.name.includes("delta_non_zero"));
    expect(target, "delta_non_zero CHECK not found").toBeDefined();

    const sql = flattenCheckSql(target!);
    expect(sql, `CHECK SQL was: "${sql}"`).toMatch(/delta_cents/);
    expect(sql, `CHECK SQL was: "${sql}"`).toMatch(/<>/);
    expect(sql, `CHECK SQL was: "${sql}"`).toMatch(/0/);
  });
});

// ---------------------------------------------------------------------------
// 4. stripe_events: unique idempotency anchor on stripe_event_id
// ---------------------------------------------------------------------------

describe("stripe_events unique idempotency constraint", () => {
  it("has a stripe_event_id column", () => {
    const cols = sqlColumnNames(stripeEvents);
    expect(cols).toContain("stripe_event_id");
  });

  it("has a unique index on stripe_event_id", () => {
    const cfg = getTableConfig(stripeEvents);
    const uniqueIndexNames = cfg.indexes
      .filter((idx) => idx.config.unique === true)
      .map((idx) => idx.config.name);
    expect(
      uniqueIndexNames.some((n) => n?.includes("stripe_event")),
      `Expected a unique index containing "stripe_event" but found: [${uniqueIndexNames.join(", ")}]`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. security_events: outcome CHECK constraint exists
// ---------------------------------------------------------------------------

describe("security_events CHECK constraints", () => {
  const cfg = getTableConfig(securityEvents);
  const checks = cfg.checks as DrizzleCheck[];

  it("has an outcome column", () => {
    const cols = sqlColumnNames(securityEvents);
    expect(cols).toContain("outcome");
  });

  it("CHECK constraint name includes 'outcome_check'", () => {
    const names = checks.map((c) => c.name);
    expect(
      names.some((n) => n.includes("outcome_check")),
      `Expected a CHECK named "..._outcome_check" but found: [${names.join(", ")}]`,
    ).toBe(true);
  });
});
