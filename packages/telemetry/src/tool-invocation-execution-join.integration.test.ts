// The witness for #2615: a tool_invocations row from any of this table's
// seven producers should come back attached to the run that produced it,
// when queried against its `execution_step_id`.
//
// The read side was never dead in the way `skill-execution-join`'s was — no
// query in this codebase joins `tool_invocations` to `token_usage` on
// `execution_step_id` today — but the shape of the defect is identical: six
// of the table's seven producers hardcoded `execution_step_id: null` (the
// materialize-tools.ts factory covers the seventh), so a row from any of
// them could never be attributed to a run even if a join existed. This test
// builds that join directly, the way a future cost-per-run report would, and
// proves each fixed producer's row shape actually correlates — plus a
// control recording the OLD behaviour (`execution_step_id: null`), which
// must stay invisible to the same join.
//
// Live server rather than a mock, on this package's existing convention: a
// mocked client accepts any SQL without complaint, so it cannot tell a join
// that matches from one that cannot.
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
process.env.CLICKHOUSE_USERNAME ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "";
process.env.CLICKHOUSE_DATABASE ??= "oxagen";

// Collection-time probe with a short abort, so the suite skips before any
// hook touches the network — mirrors skill-execution-join.integration.test.ts.
async function clickhouseReachable(): Promise<boolean> {
  try {
    const url = new URL("/ping", process.env.CLICKHOUSE_URL);
    const res = await fetch(url, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

const chUp = await clickhouseReachable();

beforeAll(async () => {
  if (!chUp) return;
  const { migrate } = await import("./migrate");
  await migrate();
}, 60_000);

/**
 * The join a cost-per-run report would run: which tool_invocations rows
 * belong to a run that also spent tokens, and what did that run cost. Not a
 * shipped production query — written here, at the read boundary the DoD asks
 * for, so the test proves the DATA is joinable rather than that some
 * particular query string works.
 */
async function toolInvocationRunCost(args: {
  orgId: string;
  workspaceId: string;
  executionStepId: string;
}): Promise<number | null> {
  const { clickhouse } = await import("./clickhouse");
  const result = await clickhouse().query({
    query: `
      SELECT sum(tu.cost_usd_micros) AS cost_usd_micros
      FROM (
        SELECT DISTINCT execution_step_id
        FROM tool_invocations
        WHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
          AND execution_step_id = {executionStepId:UUID}
      ) AS ti
      INNER JOIN (
        SELECT execution_step_id, sum(cost_usd_micros) AS cost_usd_micros
        FROM token_usage
        WHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
        GROUP BY execution_step_id
      ) AS tu ON tu.execution_step_id = ti.execution_step_id
    `,
    query_params: {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      executionStepId: args.executionStepId,
    },
    format: "JSONEachRow",
  });
  type Raw = { cost_usd_micros: string | null };
  const rows = (await result.json()) as Raw[];
  const value = rows[0]?.cost_usd_micros;
  return value === null || value === undefined ? null : Number(value);
}

describe.skipIf(!chUp)("tool_invocations -> token_usage join (#2615)", () => {
  it("attributes a run's token cost to a tool_invocations row that recorded its executionStepId", async () => {
    const { insertToolInvocation, insertTokenUsage } = await import(
      "./clickhouse"
    );

    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const executionStepId = randomUUID();

    await insertTokenUsage([
      {
        execution_step_id: executionStepId,
        org_id: orgId,
        workspace_id: workspaceId,
        model: "anthropic/claude-fable-5",
        provider: "anthropic",
        input_tokens: 500,
        output_tokens: 50,
        cached_tokens: 0,
        cost_usd_micros: 21_000,
        duration_ms: 800,
        surface: "runner",
        prompt_hash: "0".repeat(32),
        created_at: new Date().toISOString(),
      },
    ]);

    // Shaped exactly as agent.background-task.execute.ts (and the other
    // three fixed inngest emitters) now build the row: a real run identity,
    // not null.
    await insertToolInvocation({
      invocation_id: randomUUID(),
      org_id: orgId,
      workspace_id: workspaceId,
      capability_name: "recall_memory",
      message_id: executionStepId,
      parent_message_id: null,
      execution_step_id: executionStepId,
      status: "completed",
      input_size_bytes: 0,
      output_size_bytes: 0,
      latency_ms: 10,
      error_class: null,
      external_provider: "",
      external_server_id: null,
      risk_level: "low",
      required_approval: 0,
      surface: "runner",
      provider: "",
      created_at: new Date().toISOString(),
    });

    const cost = await toolInvocationRunCost({
      orgId,
      workspaceId,
      executionStepId,
    });

    expect(
      cost,
      "the join returned nothing for a tool_invocations row that recorded " +
        "its run — either the producer is not writing execution_step_id, or " +
        "the two tables are keyed differently",
    ).toBe(21_000);
  }, 30_000);

  it("cannot attribute a run's cost to a tool_invocations row recorded the pre-#2615 way (execution_step_id: null)", async () => {
    const { insertToolInvocation, insertTokenUsage } = await import(
      "./clickhouse"
    );

    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const executionStepId = randomUUID();

    await insertTokenUsage([
      {
        execution_step_id: executionStepId,
        org_id: orgId,
        workspace_id: workspaceId,
        model: "anthropic/claude-fable-5",
        provider: "anthropic",
        input_tokens: 500,
        output_tokens: 50,
        cached_tokens: 0,
        cost_usd_micros: 21_000,
        duration_ms: 800,
        surface: "runner",
        prompt_hash: "0".repeat(32),
        created_at: new Date().toISOString(),
      },
    ]);

    // The control: the SAME shape every one of the six producers wrote
    // before #2615 — a real message_id, but execution_step_id hardcoded to
    // null. This is main's behaviour, and it must stay invisible to the join.
    await insertToolInvocation({
      invocation_id: randomUUID(),
      org_id: orgId,
      workspace_id: workspaceId,
      capability_name: "recall_memory",
      message_id: executionStepId,
      parent_message_id: null,
      execution_step_id: null,
      status: "completed",
      input_size_bytes: 0,
      output_size_bytes: 0,
      latency_ms: 10,
      error_class: null,
      external_provider: "",
      external_server_id: null,
      risk_level: "low",
      required_approval: 0,
      surface: "runner",
      provider: "",
      created_at: new Date().toISOString(),
    });

    // Querying by the run's executionStepId finds nothing on the
    // tool_invocations side, because the row never recorded it.
    const cost = await toolInvocationRunCost({
      orgId,
      workspaceId,
      executionStepId,
    });

    expect(cost).toBeNull();
  }, 30_000);
});
