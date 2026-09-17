/**
 * tacho.sessions must hold no readable email address (#3072).
 *
 * The column used to carry the real address of the person behind the session,
 * the only column on the table that identified a person in the clear.
 *
 * The digest is keyed on the control plane, so it cannot be computed in SQL
 * without putting the key into a statement and its log. The migration
 * therefore drops the addresses rather than re-encoding them. These read the
 * committed migration rather than a description of it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tachoSessions } from "./tacho";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../atlas/migrations/", import.meta.url),
);

/** Every migration body, newest first. */
function migrationsNewestFirst(): { file: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .map((file) => ({
      file,
      sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
    }));
}

const DIGEST_MIGRATION = migrationsNewestFirst().find(({ sql }) =>
  sql.includes('"anthropic_user_email_digest"'),
);

describe("tacho.sessions holds a digest, not an address", () => {
  it("has no plaintext column in the Drizzle schema", () => {
    const columns = Object.values(tachoSessions).flatMap((value) =>
      typeof value === "object" && value !== null && "name" in value
        ? [String((value as { name: unknown }).name)]
        : [],
    );
    expect(columns).toContain("anthropic_user_email_digest");
    expect(columns).not.toContain("anthropic_user_email");
    for (const name of columns) expect(name).not.toMatch(/email$/);
  });

  it("has a migration that adds the digest and drops the address", () => {
    expect(DIGEST_MIGRATION).toBeDefined();
    const sql = DIGEST_MIGRATION?.sql ?? "";
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "anthropic_user_email_digest" text',
    );
    expect(sql).toContain('DROP COLUMN IF EXISTS "anthropic_user_email"');
    // The drop is last; a statement after it that still read the column would
    // fail on a database that has already run this migration.
    const statements = sql
      .split(";")
      .map((part) =>
        part
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((part) => part.length > 0);
    expect(statements[statements.length - 1]).toContain(
      'DROP COLUMN IF EXISTS "anthropic_user_email"',
    );
  });

  it("does not backfill, and references the old column only to drop it", () => {
    const sql = DIGEST_MIGRATION?.sql ?? "";
    // The stored digest is keyed with a secret the control plane holds
    // (packages/handlers/src/lib/tacho-user-email-digest.ts). Postgres could
    // call pgcrypto's hmac() here, but the key would travel inside the
    // statement and land in the server log -- and ClickHouse, which must
    // produce the identical value for the same person, has no HMAC function at
    // all. So the rows already written lose the attribute: the addresses are
    // gone rather than re-encoded.
    const statements = sql
      .split(";")
      .map((part) =>
        part
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((part) => part.length > 0);
    expect(statements).toHaveLength(2);
    const executed = statements.join(";").toLowerCase();
    expect(executed).not.toContain("update");
    expect(executed).not.toContain("hmac");
    expect(executed).not.toContain("sha256");
    expect(executed).not.toContain("encode(");
    for (const statement of statements) {
      if (/"anthropic_user_email"/.test(statement)) {
        expect(statement).toContain("DROP COLUMN");
      }
    }
  });
});
