/**
 * The notification event CHECK exists in three places: the contract's list
 * (`NOTIFICATION_EVENTS`), the schema list the drizzle `check()` is built from
 * (`NOTIFICATION_EVENT_VALUES`), and the SQL the latest Atlas migration wrote.
 * The migration is discovered, not hard-coded: the change that adds an event
 * writes a new migration that drops and re-adds the constraint, and this guard
 * moves to it on its own.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_EVENTS } from "@oxagen/oxagen/contracts/notification.list";
import { NOTIFICATION_EVENT_VALUES, notifications } from "./notification";

const CONSTRAINT = "notifications_event_check";
const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../atlas/migrations/", import.meta.url),
);

/** The quoted values inside the `IN (...)` of the constraint's CHECK. */
function checkedValues(sql: string): string[] {
  const match = new RegExp(
    `${CONSTRAINT}"?\\s+CHECK\\s*\\([^)]*?IN\\s*\\(([^)]*)\\)`,
  ).exec(sql);
  if (!match?.[1]) throw new Error(`${CONSTRAINT} has no IN (...) list`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

function latestMigrationDefining(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (new RegExp(`ADD CONSTRAINT "?${CONSTRAINT}"?`).test(sql))
      return { file, sql };
  }
  throw new Error(`No migration defines ${CONSTRAINT}`);
}

describe("notification events", () => {
  it("the contract publishes the schema's list", () => {
    expect([...NOTIFICATION_EVENTS]).toEqual([...NOTIFICATION_EVENT_VALUES]);
  });

  it("the latest migration defining the CHECK checks exactly the schema's list", () => {
    const { file, sql } = latestMigrationDefining();
    expect(checkedValues(sql), `${file} drifted from notification.ts`).toEqual([
      ...NOTIFICATION_EVENT_VALUES,
    ]);
  });

  it("the drizzle CHECK checks exactly the schema's list", () => {
    const check = getTableConfig(notifications).checks.find(
      (c) => c.name === CONSTRAINT,
    );
    if (!check) throw new Error(`${CONSTRAINT} is not declared`);
    const rendered = new PgDialect().sqlToQuery(check.value).sql;
    expect(checkedValues(`${CONSTRAINT} CHECK (${rendered})`)).toEqual([
      ...NOTIFICATION_EVENT_VALUES,
    ]);
  });
});
