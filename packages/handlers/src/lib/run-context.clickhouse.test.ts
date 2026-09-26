import { randomUUID } from "node:crypto";
import { runInTenantScope } from "@oxagen/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTachoModelCalls } from "./run-context";

// The read runs against a real `tacho_events`. CI migrates ClickHouse before
// the unit job, so the SQL itself is under test there (ADR-193). A machine
// without a reachable ClickHouse skips.
const url = process.env["CLICKHOUSE_URL"];
const reachable = url
  ? await fetch(new URL("/ping", url), { signal: AbortSignal.timeout(500) })
      .then((response) => response.ok)
      .catch(() => false)
  : false;

const scope = { orgId: randomUUID(), workspaceId: randomUUID() };
const session = randomUUID();
const WINDOW = "system=2000:1;tools=6000:18;conversation=12000:40";

/** One frame, every column not named here left at its default. */
function frame(seq: number, columns: Record<string, unknown>) {
  const ts = `2026-09-26 10:00:${String(seq).padStart(2, "0")}.000`;
  return {
    org_id: scope.orgId,
    workspace_id: scope.workspaceId,
    session_uuid: session,
    root_session_uuid: session,
    seq,
    ts,
    received_at: ts,
    chain_verified: true,
    ...columns,
  };
}

const FRAMES = [
  frame(0, {
    kind: "steering.manifest",
    body: JSON.stringify({ budget_tokens: 2000, spent_tokens: 1102 }),
  }),
  frame(1, { kind: "tool_call", tool_name: "Read" }),
  frame(2, {
    kind: "llm_call",
    model: "claude-opus-5",
    provider: "anthropic",
    request_id: "req_2",
    input_tokens: 1311,
    cache_read_tokens: 40022,
    cache_creation_tokens: 667,
    body: JSON.stringify({ input_tokens: 1311 }),
    attrs: { "oxagen.window": WINDOW },
  }),
  frame(3, { kind: "llm_call", model: "claude-opus-5", attrs: {} }),
];

const read = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);

describe.skipIf(!reachable)("the context read on ClickHouse", () => {
  beforeAll(async () => {
    // Imported here, not at the top: the tenancy-seam lint rule forbids a
    // static `clickhouse` import outside @oxagen/telemetry, and seeding a
    // fixture needs the raw client.
    const { clickhouse } = await import("@oxagen/telemetry");
    await clickhouse().insert({
      table: "tacho_events",
      format: "JSONEachRow",
      values: FRAMES,
    });
  });
  afterAll(async () => {
    const { closeClickhouse } = await import("@oxagen/telemetry");
    await closeClickhouse();
  });

  it("reads the model calls and manifests in frame order, with the window and the usage columns", async () => {
    const rows = await read(() => readTachoModelCalls(session, 10));
    expect(rows.map((row) => [row.seq, row.kind])).toEqual([
      [0, "steering.manifest"],
      [2, "llm_call"],
      [3, "llm_call"],
    ]);
    expect(rows[1]).toMatchObject({
      model: "claude-opus-5",
      provider: "anthropic",
      requestId: "req_2",
      inputTokens: 1311,
      cacheReadTokens: 40022,
      cacheCreationTokens: 667,
      // A model call's body is left out: the typed columns carry its usage.
      body: "",
    });
    expect(rows[1]?.attrs?.["oxagen.window"]).toBe(WINDOW);
    expect(JSON.parse(rows[0]?.body ?? "{}")).toMatchObject({
      budget_tokens: 2000,
    });
    expect(rows[2]?.inputTokens).toBeNull();
  });

  it("stops at the limit it is given", async () => {
    const rows = await read(() => readTachoModelCalls(session, 1));
    expect(rows).toHaveLength(1);
  });
});
