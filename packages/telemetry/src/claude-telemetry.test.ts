// claude-telemetry.test.ts
//
// ADR-183 keeps `claude_sessions.user_email` for the table's two-year TTL and
// erases one person's rows on request. These cases tie that decision to the
// committed SQL: the table the erasure deletes from, the column it matches,
// and the TTL the ADR names are read out of migration 0007 rather than
// restated here.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const command = vi.hoisted(() => vi.fn(async () => ({ query_id: "q" })));
/** What each read of `system.mutations` answers, in order; then none pending. */
const polls = vi.hoisted(
  () => [] as Array<{ pending: string; failing: string }>,
);
const query = vi.hoisted(() =>
  vi.fn(async () => ({
    json: async () => [polls.shift() ?? { pending: "0", failing: "0" }],
  })),
);

vi.mock("./clickhouse", () => ({
  clickhouse: () => ({ command, query }),
}));

import {
  CLAUDE_SESSIONS_EMAIL_COLUMN,
  CLAUDE_SESSIONS_TABLE,
  ERASE_CLAUDE_SESSIONS_QUERY,
  ERASE_CLAUDE_SESSIONS_WAIT_MS,
  PENDING_CLAUDE_SESSIONS_MUTATIONS_QUERY,
  eraseClaudeSessionRows,
} from "./claude-telemetry";

const here = dirname(fileURLToPath(import.meta.url));
const migration0007 = readFileSync(
  join(here, "migrations", "0007_claude_sessions.sql"),
  "utf8",
);

beforeEach(() => {
  command.mockClear();
  query.mockClear();
  polls.length = 0;
});

/** A clock that moves only when the erase sleeps. */
function fakeClock() {
  let at = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => at,
    sleep: async (ms: number) => {
      slept.push(ms);
      at += ms;
    },
  };
}

describe("claude_sessions as 0007 creates it", () => {
  it("creates the table the erasure deletes from", () => {
    expect(migration0007).toMatch(
      new RegExp(
        `^CREATE TABLE IF NOT EXISTS ${CLAUDE_SESSIONS_TABLE} \\(`,
        "m",
      ),
    );
  });

  it("holds the address in the column the erasure matches, first in the sort key", () => {
    expect(migration0007).toMatch(
      new RegExp(`^\\s+${CLAUDE_SESSIONS_EMAIL_COLUMN}\\s+LowCardinality`, "m"),
    );
    expect(migration0007).toMatch(
      new RegExp(`^ORDER BY \\(${CLAUDE_SESSIONS_EMAIL_COLUMN},`, "m"),
    );
  });

  it("keeps rows for the two years ADR-183 names", () => {
    expect(migration0007).toMatch(
      /^TTL toDateTime\(timestamp\) \+ INTERVAL 2 YEAR;$/m,
    );
  });

  it("no later migration drops the column or changes the TTL the ADR relies on", () => {
    const later = readdirSync(join(here, "migrations"))
      .filter((file) => file.endsWith(".sql") && file > "0007_")
      .map((file) => readFileSync(join(here, "migrations", file), "utf8"));
    expect(later.length).toBeGreaterThan(0);
    for (const sql of later) {
      expect(sql).not.toMatch(
        new RegExp(
          `ALTER TABLE ${CLAUDE_SESSIONS_TABLE}\\s+(DROP COLUMN[^;]*${CLAUDE_SESSIONS_EMAIL_COLUMN}|REMOVE TTL|MODIFY TTL)`,
        ),
      );
    }
  });
});

describe("eraseClaudeSessionRows", () => {
  it("deletes every row that names the address, with the address bound as a parameter", async () => {
    await eraseClaudeSessionRows("person@example.test");
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith({
      query: ERASE_CLAUDE_SESSIONS_QUERY,
      query_params: { email: "person@example.test" },
      clickhouse_settings: { mutations_sync: "0" },
    });
    expect(ERASE_CLAUDE_SESSIONS_QUERY).toBe(
      "ALTER TABLE claude_sessions DELETE WHERE user_email = {email:String}",
    );
    expect(ERASE_CLAUDE_SESSIONS_QUERY).not.toContain("person@example.test");
  });

  it("refuses an empty address, which would match rows that carry none", async () => {
    await expect(eraseClaudeSessionRows("  ")).rejects.toThrow(/non-empty/);
    expect(command).not.toHaveBeenCalled();
  });

  // #4316: the statement used to wait for the mutation itself, and the shared
  // client gives up on a request after 30 seconds, so an erase over a large
  // table failed on every attempt.
  it("waits past 30 seconds for a long mutation, one short read at a time", async () => {
    const clock = fakeClock();
    for (let i = 0; i < 6; i += 1) polls.push({ pending: "1", failing: "0" });
    await eraseClaudeSessionRows("person@example.test", clock);
    expect(clock.now()).toBeGreaterThan(30_000);
    expect(clock.slept).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
    expect(query).toHaveBeenCalledTimes(7);
    expect(query).toHaveBeenCalledWith({
      query: PENDING_CLAUDE_SESSIONS_MUTATIONS_QUERY,
      query_params: { table: CLAUDE_SESSIONS_TABLE },
      format: "JSONEachRow",
    });
    expect(PENDING_CLAUDE_SESSIONS_MUTATIONS_QUERY).toContain(
      "system.mutations",
    );
    expect(PENDING_CLAUDE_SESSIONS_MUTATIONS_QUERY).toContain("is_done = 0");
  });

  it("returns at once when the mutation is already done (negative)", async () => {
    const clock = fakeClock();
    await eraseClaudeSessionRows("person@example.test", clock);
    expect(clock.slept).toEqual([]);
    expect(query).toHaveBeenCalledOnce();
  });

  it("throws once the wait runs out, and says when the mutation is failing", async () => {
    const clock = fakeClock();
    for (let i = 0; i < 200; i += 1) polls.push({ pending: "1", failing: "1" });
    await expect(
      eraseClaudeSessionRows("person@example.test", clock),
    ).rejects.toThrow(/did not finish within 900 seconds.*1 of them failing/);
    expect(clock.now()).toBeGreaterThanOrEqual(ERASE_CLAUDE_SESSIONS_WAIT_MS);
  });

  it("passes a ClickHouse refusal to the caller", async () => {
    command.mockRejectedValueOnce(new Error("TOO_MANY_MUTATIONS"));
    await expect(eraseClaudeSessionRows("person@example.test")).rejects.toThrow(
      "TOO_MANY_MUTATIONS",
    );
  });
});
