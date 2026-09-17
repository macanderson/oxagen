/**
 * The `tacho_events` table must carry no readable email address (#3072), and
 * the backfill that removed the ones already written must compute the same
 * digest the collector writes — otherwise a backfilled row would never join a
 * newly written one for the same person.
 *
 * These read the committed migration files rather than trusting a description
 * of them, so reintroducing the plaintext column, or drifting the SQL away
 * from `digestUserEmail`, fails here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestBytes, digestUserEmail } from "@oxagen/tacho";
import { describe, expect, it } from "vitest";
import { tachoEventsColumns } from "./tacho-events-ddl";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) =>
  readFileSync(join(here, "migrations", file), "utf8");

const CREATE = "0027_tacho_events.sql";
const DIGEST = "0028_tacho_events_email_digest.sql";

describe("tacho_events carries no email address", () => {
  it("has no plaintext column in the generated table", () => {
    const names = tachoEventsColumns().map((column) => column.name);
    expect(names).not.toContain("anthropic_user_email");
    expect(names).toContain("anthropic_user_email_digest");
    for (const name of names) expect(name).not.toMatch(/email$/);
  });

  it("creates the table with the digest column and nothing else email-shaped", () => {
    const sql = read(CREATE);
    expect(sql).toContain("anthropic_user_email_digest String");
    expect(sql).not.toMatch(/^\s*anthropic_user_email String,?$/m);
  });

  it("drops the plaintext column from planes that already have it", () => {
    const sql = read(DIGEST);
    expect(sql).toContain(
      "ALTER TABLE tacho_events DROP COLUMN IF EXISTS anthropic_user_email;",
    );
    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS anthropic_user_email_digest String",
    );
    // The drop has to be the last statement: anything after it that still
    // reads the column would fail on a plane that has already run this.
    const statements = sql
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !part.startsWith("--"));
    expect(statements[statements.length - 1]).toContain(
      "DROP COLUMN IF EXISTS anthropic_user_email",
    );
  });

  it("backfills with the same domain-separated digest the collector writes", () => {
    const sql = read(DIGEST);
    const domain = /concat\('([^']+)',\s*lower\(trimBoth/.exec(sql)?.[1];
    expect(domain).toBeDefined();
    // The file spells the NUL byte as the two characters `\0`, which is what
    // ClickHouse's string-literal escape turns into one zero byte.
    const domainBytes = (domain as string).replace(/\\0/g, "\0");
    expect(domainBytes).toContain("\0");
    const address = "Ada.Lovelace@example.com";
    expect(digestBytes(`${domainBytes}ada.lovelace@example.com`)).toBe(
      digestUserEmail(address),
    );
  });

  it("lowercases the address the same way on both sides", () => {
    const sql = read(DIGEST);
    expect(sql).toContain("lower(trimBoth(anthropic_user_email))");
    expect(sql).toContain("lower(hex(SHA256(");
    expect(sql).toContain("concat('sha256:'");
  });
});
