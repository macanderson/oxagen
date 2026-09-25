// reply-feedback.test.ts
//
// recordReplyFeedback and readReplyFeedback over a mocked tenant seam. The
// seam (chInsert/chSelect) is what stamps and filters the tenant, so these
// tests assert what the module hands it: the table, the row, the query, and
// the params. A mocked ClickHouse cannot run the SQL, so the query is also
// checked against the table's DDL in migration 0030.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const chInsert = vi.fn(
  async (_table: string, _rows: readonly Record<string, unknown>[]) => {},
);
const chSelect = vi.fn(
  async <T>(_q: { query: string; params?: Record<string, unknown> }) => ({
    data: [] as T[],
  }),
);

vi.mock("./tenant", () => ({
  chInsert: (table: string, rows: readonly Record<string, unknown>[]) =>
    chInsert(table, rows),
  chSelect: (q: { query: string; params?: Record<string, unknown> }) =>
    chSelect(q),
}));

import {
  readReplyFeedback,
  recordReplyFeedback,
  REPLY_FEEDBACK_TABLE,
  type ReplyFeedbackRow,
} from "./reply-feedback";

const here = dirname(fileURLToPath(import.meta.url));

const row: ReplyFeedbackRow = {
  run_public_id: "arun_0123456789abcdef012345",
  conversation_id: "0192d4a8-7c1e-7a00-8000-0000000000c1",
  message_id: "0192d4a8-7c1e-7a00-8000-0000000000d2",
  user_id: "0192d4a8-7c1e-7a00-8000-0000000000e3",
  verdict: "wrong",
  note: "It named the wrong agent.",
  created_at: "2026-09-25T10:00:00.000Z",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("recordReplyFeedback", () => {
  it("appends exactly one row to assistant_reply_feedback, without tenant columns", async () => {
    await recordReplyFeedback(row);

    expect(chInsert).toHaveBeenCalledTimes(1);
    const [table, rows] = chInsert.mock.calls[0]!;
    expect(table).toBe("assistant_reply_feedback");
    expect(rows).toEqual([row]);
    // chInsert stamps the scope. A row that carried its own would be
    // overwritten, so the module never sends one.
    expect(rows[0]).not.toHaveProperty("org_id");
    expect(rows[0]).not.toHaveProperty("workspace_id");
  });

  it("lets a refused insert reach the caller", async () => {
    chInsert.mockRejectedValueOnce(new Error("clickhouse down"));
    await expect(recordReplyFeedback(row)).rejects.toThrow("clickhouse down");
  });
});

describe("readReplyFeedback", () => {
  it("takes the newest vote per person and run, filtered to the scope and window", async () => {
    chSelect.mockResolvedValueOnce({
      data: [
        {
          run_public_id: "arun_0123456789abcdef012345",
          voter_id: row.user_id,
          latest_conversation_id: row.conversation_id,
          latest_message_id: row.message_id,
          latest_verdict: "wrong",
          latest_note: "It named the wrong agent.",
          latest_at: "2026-09-25 10:00:00.000",
        },
        {
          run_public_id: "arun_abcdef0123456789abcdef",
          voter_id: row.user_id,
          latest_conversation_id: row.conversation_id,
          latest_message_id: "0192d4a8-7c1e-7a00-8000-0000000000d9",
          latest_verdict: "useful",
          latest_note: "",
          latest_at: "2026-09-24 09:00:00.000",
        },
      ] as never[],
    });

    const votes = await readReplyFeedback({ windowDays: 30, limit: 100 });

    const { query, params } = chSelect.mock.calls[0]![0];
    expect(query).toContain(`FROM ${REPLY_FEEDBACK_TABLE}`);
    expect(query).toContain("org_id = {orgId:UUID}");
    expect(query).toContain("workspace_id = {workspaceId:UUID}");
    expect(query).toContain("argMax(verdict, created_at)");
    expect(query).toContain("GROUP BY run_public_id, user_id");
    expect(query).not.toContain("HAVING");
    expect(query).not.toContain("IN {runIds");
    expect(params).toEqual({ windowDays: 30, limit: 100 });
    expect(votes).toEqual([
      {
        runId: "arun_0123456789abcdef012345",
        conversationId: row.conversation_id,
        messageId: row.message_id,
        userId: row.user_id,
        verdict: "wrong",
        note: "It named the wrong agent.",
        votedAt: "2026-09-25 10:00:00.000",
      },
      {
        runId: "arun_abcdef0123456789abcdef",
        conversationId: row.conversation_id,
        messageId: "0192d4a8-7c1e-7a00-8000-0000000000d9",
        userId: row.user_id,
        verdict: "useful",
        note: null,
        votedAt: "2026-09-24 09:00:00.000",
      },
    ]);
  });

  it("filters on the aggregate verdict and on named runs, the replay set's read", async () => {
    await readReplyFeedback({
      windowDays: 7,
      verdict: "wrong",
      runIds: ["arun_0123456789abcdef012345"],
      limit: 20,
    });

    const { query, params } = chSelect.mock.calls[0]![0];
    expect(query).toContain("AND run_public_id IN {runIds:Array(String)}");
    // The HAVING names the aggregate's alias, so it reads the newest vote and
    // not every row that ever said "wrong".
    expect(query).toContain("HAVING latest_verdict = {verdict:String}");
    expect(params).toEqual({
      windowDays: 7,
      limit: 20,
      verdict: "wrong",
      runIds: ["arun_0123456789abcdef012345"],
    });
  });

  it("answers an empty run list without a round trip", async () => {
    expect(
      await readReplyFeedback({ windowDays: 7, runIds: [], limit: 20 }),
    ).toEqual([]);
    expect(chSelect).not.toHaveBeenCalled();
  });

  it("reads only columns the migration creates", () => {
    const ddl = readFileSync(
      join(here, "migrations", "0030_assistant_reply_feedback.sql"),
      "utf8",
    );
    for (const column of [
      "org_id UUID",
      "workspace_id UUID",
      "run_public_id String",
      "conversation_id UUID",
      "message_id UUID",
      "user_id UUID",
      "verdict LowCardinality(String)",
      "note String",
      "created_at DateTime64(3)",
    ]) {
      expect(ddl).toContain(column);
    }
    expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${REPLY_FEEDBACK_TABLE}`);
  });
});
