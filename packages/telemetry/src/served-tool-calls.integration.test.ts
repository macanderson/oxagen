import { randomUUID } from "node:crypto";
import { runInTenantScope } from "@oxagen/tenancy";
import { describe, expect, it } from "vitest";
import { readServedToolFeedback, recordServedToolCall, type ServedToolCallRow } from "./served-tool-calls";

// CI migrates ClickHouse before the unit job, so `served_tool_calls` exists.
// Missing configuration skips local collection. This is the witness that both
// reads run on the server, through the tenant rewrite, and that the retry
// count follows a run's calls in time order (ADR-234).

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

describe.skipIf(!process.env["CLICKHOUSE_URL"])("served tool feedback against a live store", () => {
  it("counts calls, schema rejections, error results, and retries per tool of one server", async () => {
    const scope = { orgId: randomUUID(), workspaceId: randomUUID() };
    const now = Date.now();
    const at = (ms: number) => new Date(now - ms).toISOString();
    const refund = "billing__create_refund";
    const charges = "billing__list_charges";
    const call = (over: Partial<ServedToolCallRow> & Pick<ServedToolCallRow, "created_at">): ServedToolCallRow => ({
      server: "billing",
      tool: refund,
      run_public_id: "tse_witnessrunone00000000",
      outcome: "allowed",
      problem: "",
      ...over,
    });

    const rows: ServedToolCallRow[] = [
      // Run one: an error result, then two more calls. Both later calls are retries.
      call({ created_at: at(50 * MINUTE_MS), outcome: "failed", problem: "error_result" }),
      call({ created_at: at(49 * MINUTE_MS) }),
      call({ created_at: at(48 * MINUTE_MS), outcome: "failed", problem: "schema_rejected" }),
      // Run one, before its first problem: a call, not a retry.
      call({ created_at: at(51 * MINUTE_MS) }),
      // Run two: one clean call.
      call({ run_public_id: "tse_witnessruntwo00000000", created_at: at(40 * MINUTE_MS) }),
      // No run: a schema rejection that counts, and a call after it that is no retry.
      call({ run_public_id: "", created_at: at(30 * MINUTE_MS), outcome: "failed", problem: "schema_rejected" }),
      call({ run_public_id: "", created_at: at(29 * MINUTE_MS) }),
      // Denied and parked calls never reached the tool.
      call({ created_at: at(20 * MINUTE_MS), outcome: "denied" }),
      call({ created_at: at(19 * MINUTE_MS), outcome: "parked" }),
      // A denial because Cedar could not read the arguments counts as a
      // rejection. It is run two's first problem, and nothing follows it.
      call({ run_public_id: "tse_witnessruntwo00000000", created_at: at(18 * MINUTE_MS), outcome: "denied", problem: "schema_rejected" }),
      // Outside the window.
      call({ created_at: at(40 * DAY_MS), outcome: "failed", problem: "error_result" }),
      // Another tool of the server: a rejection, then a retry.
      call({ tool: charges, run_public_id: "tse_witnessrunthree000000", created_at: at(10 * MINUTE_MS), outcome: "failed", problem: "schema_rejected" }),
      call({ tool: charges, run_public_id: "tse_witnessrunthree000000", created_at: at(9 * MINUTE_MS) }),
      // Another server's tool.
      call({ server: "stripe", tool: "stripe__create_refund", created_at: at(5 * MINUTE_MS) }),
    ];
    await runInTenantScope(scope, async () => {
      for (const row of rows) await recordServedToolCall(row);
    });
    // Another workspace's call to the same tool.
    await runInTenantScope({ orgId: scope.orgId, workspaceId: randomUUID() }, () =>
      recordServedToolCall(call({ created_at: at(MINUTE_MS) })),
    );

    const feedback = await runInTenantScope(scope, () =>
      readServedToolFeedback({ server: "billing", windowDays: 30 }),
    );

    expect(feedback).toEqual([
      { tool: refund, calls: 8, schemaRejections: 3, errorResults: 1, retries: 2 },
      { tool: charges, calls: 2, schemaRejections: 1, errorResults: 0, retries: 1 },
    ]);
  });
});
