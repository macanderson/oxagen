/**
 * Regression guard for encryptedBytea — the Drizzle customType helper used by
 * encrypted-bytea columns across the schema.
 *
 * These tests are intentionally minimal: they confirm that the column builder
 * produces a bytea column with the correct SQL type and name so that future
 * refactors cannot silently change the wire type and break the DB schema.
 *
 * We build a temporary pgTable so that Drizzle runs the column builder and
 * exposes the fully-resolved `.getSQLType()` and `.name` properties.
 */

import { describe, it, expect } from "vitest";
import { pgTable } from "drizzle-orm/pg-core";
import { encryptedBytea } from "./drizzle";

describe("encryptedBytea", () => {
  it("getSQLType() returns 'bytea'", () => {
    const t = pgTable("_test", { enc: encryptedBytea("my_enc_col") });
    expect(t.enc.getSQLType()).toBe("bytea");
  });

  it("carries the column name supplied to the builder", () => {
    const t = pgTable("_test2", { enc: encryptedBytea("access_token_enc") });
    expect(t.enc.name).toBe("access_token_enc");
  });

  it("two calls with different names produce distinct column names", () => {
    const t = pgTable("_test3", {
      a: encryptedBytea("token_a"),
      b: encryptedBytea("token_b"),
    });
    expect(t.a.name).toBe("token_a");
    expect(t.b.name).toBe("token_b");
    expect(t.a.name).not.toBe(t.b.name);
  });

  it("dataType is 'custom' (confirms Drizzle customType wrapper)", () => {
    const t = pgTable("_test4", { enc: encryptedBytea("payload_enc") });
    // Drizzle's customType always reports dataType as "custom" internally;
    // the actual SQL type is in getSQLType().
    expect(t.enc.dataType).toBe("custom");
  });
});
