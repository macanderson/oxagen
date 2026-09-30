// served-tool-calls.test.ts
//
// recordServedToolCall and readServedToolFeedback over a mocked tenant seam.
// The seam (chInsert/chSelect) stamps and filters the tenant, so these tests
// assert what the module hands it. Each read's SQL also goes through the real
// tenant rewrite, which refuses any query it cannot scope, and is checked
// against the table's DDL in migration 0037. The live server runs the SQL in
// served-tool-calls.integration.test.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const chInsert = vi.fn(async (_table: string, _rows: readonly Record<string, unknown>[]) => {});
const chSelect = vi.fn(async <T>(_q: { query: string; params?: Record<string, unknown> }) => ({
  data: [] as T[],
}));

vi.mock("./tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("./tenant")>();
  return {
    scopeSelectSource: real.scopeSelectSource,
    chInsert: (table: string, rows: readonly Record<string, unknown>[]) => chInsert(table, rows),
    chSelect: (q: { query: string; params?: Record<string, unknown> }) => chSelect(q),
  };
});

import { scopeSelectSource } from "./tenant";
import {
  readServedToolFeedback,
  recordServedToolCall,
  SERVED_TOOL_CALLS_TABLE,
  type ServedToolCallRow,
} from "./served-tool-calls";

const here = dirname(fileURLToPath(import.meta.url));

const row: ServedToolCallRow = {
  server: "billing",
  tool: "billing__create_refund",
  run_public_id: "tse_0123456789abcdef012345",
  outcome: "failed",
  problem: "schema_rejected",
  created_at: "2026-09-30T10:00:00.000Z",
};

afterEach(() => {
  vi.clearAllMocks();
});

/** Answer the totals read, then the runs read, in the order the module sends them. */
function answer(totals: unknown[], runs: unknown[]): void {
  chSelect.mockImplementation(async <T>(q: { query: string }) => ({
    data: (q.query.includes("HAVING") ? runs : totals) as T[],
  }));
}

describe("recordServedToolCall", () => {
  it("appends exactly one row to served_tool_calls, without tenant columns", async () => {
    await recordServedToolCall(row);

    expect(chInsert).toHaveBeenCalledTimes(1);
    const [table, rows] = chInsert.mock.calls[0]!;
    expect(table).toBe(SERVED_TOOL_CALLS_TABLE);
    expect(rows).toEqual([row]);
    expect(rows[0]).not.toHaveProperty("org_id");
    expect(rows[0]).not.toHaveProperty("workspace_id");
  });

  it("lets a refused insert reach the caller", async () => {
    chInsert.mockRejectedValueOnce(new Error("clickhouse down"));
    await expect(recordServedToolCall(row)).rejects.toThrow("clickhouse down");
  });
});

describe("readServedToolFeedback", () => {
  it("counts per tool and adds each problem run's calls after its first problem as retries", async () => {
    answer(
      [
        { tool: "billing__create_refund", calls: "7", schema_rejections: "2", error_results: "1" },
        { tool: "billing__list_charges", calls: "4", schema_rejections: "0", error_results: "0" },
      ],
      [
        // Five calls, the first problem at the second: three retries.
        { tool: "billing__create_refund", calls: "5", first_problem: "2" },
        // The only call had the problem: no retry.
        { tool: "billing__create_refund", calls: "1", first_problem: "1" },
      ],
    );

    await expect(readServedToolFeedback({ server: "billing", windowDays: 30 })).resolves.toEqual([
      { tool: "billing__create_refund", calls: 7, schemaRejections: 2, errorResults: 1, retries: 3 },
      { tool: "billing__list_charges", calls: 4, schemaRejections: 0, errorResults: 0, retries: 0 },
    ]);
  });

  it("names the server and the window in both reads, and floors the window at zero", async () => {
    answer([], []);
    await readServedToolFeedback({ server: "billing", windowDays: -3.7 });

    expect(chSelect).toHaveBeenCalledTimes(2);
    for (const [q] of chSelect.mock.calls) {
      expect(q.params).toEqual({ server: "billing", windowDays: 0 });
      expect(q.query).toContain(`FROM ${SERVED_TOOL_CALLS_TABLE}`);
      expect(q.query).toMatch(/server = \{server:String\}/);
      expect(q.query).toMatch(/\(outcome IN \('allowed', 'failed'\) OR problem != ''\)/);
      expect(q.query).toMatch(/created_at >= now\(\) - toIntervalDay\(\{windowDays:UInt32\}\)/);
    }
  });

  it("reads retries only from runs that had a problem and name a session", async () => {
    answer([], []);
    await readServedToolFeedback({ server: "billing", windowDays: 30 });

    const runs = chSelect.mock.calls.map(([q]) => q.query).find((query) => query.includes("HAVING"));
    expect(runs).toMatch(/run_public_id != ''/);
    expect(runs).toMatch(/HAVING countIf\(problem != ''\) > 0/);
    expect(runs).toMatch(/GROUP BY tool, run_public_id/);
  });

  it("sends only queries the tenant rewrite can scope", async () => {
    answer([], []);
    await readServedToolFeedback({ server: "billing", windowDays: 30 });

    for (const [q] of chSelect.mock.calls) {
      expect(() => scopeSelectSource(q.query)).not.toThrow();
    }
  });

  it("reads and writes only columns migration 0037 declares", async () => {
    const ddl = readFileSync(join(here, "migrations", "0037_served_tool_calls.sql"), "utf8");
    for (const column of Object.keys(row)) expect(ddl).toMatch(new RegExp(`^\\s+${column}\\s`, "m"));
    for (const column of ["org_id", "workspace_id", "problem", "outcome", "run_public_id"]) {
      expect(ddl).toMatch(new RegExp(`^\\s+${column}\\s`, "m"));
    }
    const schema = readFileSync(join(here, "schema.sql"), "utf8");
    expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${SERVED_TOOL_CALLS_TABLE} (`);
  });
});
