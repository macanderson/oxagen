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
const ttl = /ALTER TABLE tacho_events\s+(?:MODIFY|REMOVE) TTL[^;]*/g;

describe("TACHO_EVENTS_RETENTION_MONTHS", () => {
  it("is the TTL migration 0032 gives tacho_events", () => {
    const sql = readFileSync(
      join(migrations, "0032_tacho_events_ttl.sql"),
      "utf8",
    );
    expect(sql).toContain(
      `MODIFY TTL toDateTime(received_at) + INTERVAL ${TACHO_EVENTS_RETENTION_MONTHS} MONTH`,
    );
  });

  it("is still the TTL: no later migration changes or removes it", () => {
    const later = readdirSync(migrations)
      .filter((file) => file.endsWith(".sql") && file > "0032_")
      .flatMap((file) =>
        [...readFileSync(join(migrations, file), "utf8").matchAll(ttl)].map(
          (match) => match[0],
        ),
      );
    for (const statement of later) {
      expect(statement).toContain(
        `toDateTime(received_at) + INTERVAL ${TACHO_EVENTS_RETENTION_MONTHS} MONTH`,
      );
    }
  });
});
