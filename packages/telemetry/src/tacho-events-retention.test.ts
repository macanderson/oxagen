// tacho-events-retention.test.ts
//
// The retention constant readers use (#4316) must say what the TTL on
// `tacho_events` says. Both are read from the committed SQL rather than
// restated here.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TACHO_EVENTS_RETENTION_MONTHS } from "./tacho-events-retention";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const TTL = `toDateTime(received_at) + INTERVAL ${TACHO_EVENTS_RETENTION_MONTHS} MONTH`;

/**
 * Every statement in `sql` that sets or drops the TTL `tacho_events` carries:
 * an ALTER of its TTL, and the CREATE TABLE of `tacho_events` itself or of a
 * table that later takes its place (RENAME TABLE, EXCHANGE TABLES), which is
 * how a rebuild such as a partition-key change replaces it.
 */
function ttlStatements(sql: string): string[] {
  const alters = [
    ...sql.matchAll(/ALTER TABLE tacho_events\s+(?:MODIFY|REMOVE) TTL[^;]*/g),
  ].map((match) => match[0]);
  const replacing = new Set(["tacho_events"]);
  for (const match of sql.matchAll(
    /RENAME TABLE (\w+) TO tacho_events\b|EXCHANGE TABLES (\w+) AND tacho_events\b|EXCHANGE TABLES tacho_events AND (\w+)/g,
  )) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name !== undefined) replacing.add(name);
  }
  const creates = [
    ...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)[^;]*/g),
  ]
    .filter((match) => replacing.has(match[1] as string))
    .map((match) => match[0]);
  return [...alters, ...creates];
}

describe("TACHO_EVENTS_RETENTION_MONTHS", () => {
  it("is the TTL migration 0032 gives tacho_events", () => {
    const sql = readFileSync(
      join(migrations, "0032_tacho_events_ttl.sql"),
      "utf8",
    );
    expect(sql).toContain(`MODIFY TTL ${TTL}`);
  });

  it("is still the TTL: no later migration changes, removes, or rebuilds it without it", () => {
    const later = readdirSync(migrations)
      .filter((file) => file.endsWith(".sql") && file > "0032_")
      .flatMap((file) =>
        ttlStatements(readFileSync(join(migrations, file), "utf8")),
      );
    for (const statement of later) {
      expect(statement).toContain(TTL);
    }
  });

  it("finds a rebuild that would drop the TTL", () => {
    const rebuild = [
      "CREATE TABLE tacho_events_v2 (seq UInt64) ENGINE = MergeTree ORDER BY seq;",
      "EXCHANGE TABLES tacho_events_v2 AND tacho_events;",
      "CREATE TABLE IF NOT EXISTS tacho_events (seq UInt64) ENGINE = MergeTree ORDER BY seq;",
      "CREATE TABLE tacho_turns (seq UInt64) ENGINE = MergeTree ORDER BY seq;",
    ].join("\n");
    const found = ttlStatements(rebuild);
    expect(found).toHaveLength(2);
    for (const statement of found) expect(statement).not.toContain(TTL);
  });
});
