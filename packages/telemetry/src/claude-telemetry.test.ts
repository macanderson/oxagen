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
type Unfinished = { mutation_id: string; latest_fail_reason: string };
/**
 * What each read of `system.mutations` answers, in order: the unfinished
 * mutations on the table. Once the list runs out, none is unfinished.
 */
const reads = vi.hoisted(() => [] as Unfinished[][]);
const query = vi.hoisted(() =>
  vi.fn(async () => ({
    json: async () => reads.shift() ?? [],
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
  UNFINISHED_CLAUDE_SESSIONS_MUTATIONS_QUERY,
  claudeSessionsEraseRemaining,
  eraseClaudeSessionRows,
  submitClaudeSessionsErase,
} from "./claude-telemetry";

/** An unfinished mutation, failing when `reason` is given. */
const running = (id: string, reason = ""): Unfinished => ({
  mutation_id: id,
  latest_fail_reason: reason,
});

const here = dirname(fileURLToPath(import.meta.url));
const migration0007 = readFileSync(
  join(here, "migrations", "0007_claude_sessions.sql"),
  "utf8",
);

beforeEach(() => {
  command.mockClear();
  query.mockClear();
  reads.length = 0;
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
    reads.push([], [running("m2")]);
    for (let i = 0; i < 6; i += 1) reads.push([running("m2")]);
    await eraseClaudeSessionRows("person@example.test", clock);
    expect(clock.now()).toBeGreaterThan(30_000);
    expect(clock.slept).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
    expect(query).toHaveBeenCalledWith({
      query: UNFINISHED_CLAUDE_SESSIONS_MUTATIONS_QUERY,
      query_params: { table: CLAUDE_SESSIONS_TABLE },
      format: "JSONEachRow",
    });
    expect(UNFINISHED_CLAUDE_SESSIONS_MUTATIONS_QUERY).toContain(
      "system.mutations",
    );
    expect(UNFINISHED_CLAUDE_SESSIONS_MUTATIONS_QUERY).toContain("is_done = 0");
  });

  it("returns at once when the mutation is already done (negative)", async () => {
    const clock = fakeClock();
    await eraseClaudeSessionRows("person@example.test", clock);
    expect(clock.slept).toEqual([]);
  });

  it("throws once the wait runs out", async () => {
    const clock = fakeClock();
    reads.push([]);
    for (let i = 0; i < 200; i += 1) reads.push([running("m2")]);
    await expect(
      eraseClaudeSessionRows("person@example.test", clock),
    ).rejects.toThrow(/did not finish within 900 seconds/);
    expect(clock.now()).toBeGreaterThanOrEqual(ERASE_CLAUDE_SESSIONS_WAIT_MS);
  });

  // The wait used to count every unfinished mutation on the table, so one
  // that never finished made every later erase run out its wait and fail.
  it("returns once its own mutation finishes while an older one stays unfinished", async () => {
    const clock = fakeClock();
    reads.push(
      [running("m1", "Memory limit exceeded")],
      [running("m1", "Memory limit exceeded"), running("m2")],
      [running("m1", "Memory limit exceeded"), running("m2")],
      [running("m1", "Memory limit exceeded")],
    );
    await eraseClaudeSessionRows("person@example.test", clock);
    expect(clock.slept).toEqual([1_000]);
  });

  it("throws at once when its own mutation fails, without naming the reason", async () => {
    const clock = fakeClock();
    reads.push([], [running("m2")], [running("m2", "while DELETE WHERE ...")]);
    const error = await eraseClaudeSessionRows(
      "person@example.test",
      clock,
    ).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error?.message).toMatch(/mutation m2 failing/);
    expect(error?.message).not.toContain("DELETE WHERE");
    expect(clock.slept).toEqual([]);
  });

  it("passes a ClickHouse refusal to the caller", async () => {
    command.mockRejectedValueOnce(new Error("TOO_MANY_MUTATIONS"));
    await expect(eraseClaudeSessionRows("person@example.test")).rejects.toThrow(
      "TOO_MANY_MUTATIONS",
    );
  });
});

describe("the erase in two halves", () => {
  it("names only the mutation its own statement queued", async () => {
    reads.push([running("m1")], [running("m1"), running("m2")]);
    await expect(
      submitClaudeSessionsErase("person@example.test"),
    ).resolves.toEqual(["m2"]);
    expect(command).toHaveBeenCalledOnce();
  });

  it("names nothing when its mutation finished before the second read", async () => {
    reads.push([running("m1")], [running("m1")]);
    await expect(
      submitClaudeSessionsErase("person@example.test"),
    ).resolves.toEqual([]);
  });

  it("counts only the erase's own mutations, and none once they are gone", async () => {
    reads.push([running("m1", "stuck"), running("m2")], [running("m1")]);
    await expect(claudeSessionsEraseRemaining(["m2"])).resolves.toBe(1);
    await expect(claudeSessionsEraseRemaining(["m2"])).resolves.toBe(0);
    await expect(claudeSessionsEraseRemaining([])).resolves.toBe(0);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
