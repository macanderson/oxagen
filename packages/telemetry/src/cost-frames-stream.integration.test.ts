import { randomUUID } from "node:crypto";
import { GENESIS_CURSOR, sealEvent, type UnsealedTachoEvent } from "@oxagen/tacho";
import { runInTenantScope } from "@oxagen/tenancy";
import { describe, expect, it } from "vitest";
import { readModelCallFrames, readTachoToolCallFrames, type ModelCallFrameRow } from "./cost-frames";
import { insertTachoEvents } from "./tacho-events";

const DIGEST = `sha256:${"a".repeat(64)}`;

function frame(session: string, index: number, kind: "tool_call" | "llm_call"): UnsealedTachoEvent {
  const base = {
    v: "tacho/1.0",
    event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    session_id: "cost-stream-test",
    session_uuid: session,
    root_session_uuid: session,
    ts: new Date(Date.now() + index).toISOString(),
    fidelity: "sdk",
    source: "hook",
    agent: { agent_key: "acme.core.witness", fleet_id: "wrk_1",
      runtime: "claude-code", harness: "claude-code", wrapper_version: "2.1.1" },
    attrs: {},
  } as const;
  return kind === "tool_call"
    ? { ...base, kind: "tool_call", body: {
        tool_name: "Read", tool_status: "ok", tool_input_digest: DIGEST,
        tool_output_digest: DIGEST, tool_is_mutating: false,
      } }
    : { ...base, kind: "llm_call", body: {
        model: "claude-sonnet-5", input_tokens: 11, output_tokens: 7,
      } };

}

async function insert(scope: { orgId: string; workspaceId: string }, session: string) {
  let cursor = GENESIS_CURSOR;
  const events = Array.from({ length: 514 }, (_, index) => {
    const sealed = sealEvent(frame(session, index, index % 2 === 0 ? "tool_call" : "llm_call"), cursor);
    cursor = sealed.next;
    return { event: sealed.event, chainVerified: true };
  });
  await runInTenantScope(scope, () => insertTachoEvents(events));
}

describe.skipIf(!process.env["CLICKHOUSE_URL"])("streamed cost frames against ClickHouse", () => {
  it("preserves repeat history and model counts across pages while excluding other tenants", async () => {
    const scope = { orgId: randomUUID(), workspaceId: randomUUID() };
    const session = randomUUID();
    await insert(scope, session);
    await insert({ ...scope, workspaceId: randomUUID() }, session);
    await insert({ ...scope, orgId: randomUUID() }, session);
    const args = { ...scope, rootSessionUuid: session, sessionUuids: [session] };
    const batches: number[] = [];
    let repeated = 0;
    await readTachoToolCallFrames(args, async (rows) => {
      batches.push(rows.length);
      repeated += rows.filter((row) => row.repeated).length;
    });
    expect(batches).toEqual([256, 1]);
    expect(repeated).toBe(256);
    const modelArgs = { ...scope, run: { kind: "tacho" as const,
      rootSessionUuid: session, sessionUuids: [session] } };
    const array = await readModelCallFrames(modelArgs);
    const streamed: ModelCallFrameRow[] = [];
    await readModelCallFrames(modelArgs, async (rows) => { streamed.push(...rows); });
    expect(array).toHaveLength(257);
    expect(streamed).toEqual(array);
    expect(streamed.reduce((sum, row) => sum + row.inputUncached, 0)).toBe(257 * 11);
  });
});
