/**
 * tacho.sessions must hold no readable email address (#3072).
 *
 * The column used to carry the real address of the person behind the session,
 * the only column on the table that identified a person in the clear. The
 * schema now carries a digest, and the migration that made the change also
 * backfilled the rows already written — in SQL, because the rows are already
 * in the database and no collector will rewrite them.
 *
 * That backfill has to produce byte-for-byte what `digestUserEmail` in
 * packages/tacho/src/digest.ts produces, or a backfilled session would never
 * join a newly written one for the same person. These read the committed
 * migration rather than a description of it, and pin the resulting digest to a
 * fixed vector, so drift on either side fails here.
 */
import { createHash } from "node:crypto";
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

/**
 * The same vector packages/tacho/src/user-email-digest.test.ts pins for
 * `digestUserEmail("Ada.Lovelace@example.com")`.
 */
const EXPECTED =
  "sha256:74bfced307a6754c7a896feedc59f158892f454a80e08c05aa2f895f59628c08";

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

  it("backfills with the domain-separated digest, not a bare sha256", () => {
    const sql = DIGEST_MIGRATION?.sql ?? "";
    const domain =
      /convert_to\('([^']+)',\s*'UTF8'\)\s*\n?\s*\|\|\s*'\\x00'::bytea/.exec(
        sql,
      )?.[1];
    expect(domain).toBeDefined();
    const address = "ada.lovelace@example.com";
    const digested = `sha256:${createHash("sha256")
      .update(
        Buffer.concat([
          Buffer.from(domain as string, "utf8"),
          Buffer.from([0]),
          Buffer.from(address, "utf8"),
        ]),
      )
      .digest("hex")}`;
    expect(digested).toBe(EXPECTED);
    // A bare sha256 of a low-entropy address is reversible against any address
    // list, which is the whole reason the domain prefix is there.
    expect(digested).not.toBe(
      `sha256:${createHash("sha256").update(address).digest("hex")}`,
    );
  });

  it("normalizes case and surrounding space before digesting", () => {
    const sql = DIGEST_MIGRATION?.sql ?? "";
    expect(sql).toContain('lower(btrim("anthropic_user_email"))');
    expect(sql).toContain("encode(");
    expect(sql).toContain("'hex'");
  });
});
