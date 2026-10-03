import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clickhouse, closeClickhouse } from "./clickhouse";
import {
  readTachoWindowFrames,
  type TachoWindowFrameRow,
} from "./context-window-frames";

// The read runs against a real `tacho_events`. CI migrates ClickHouse before
// the unit job, so the SQL itself is under test there (#5341). A machine
// without a reachable ClickHouse skips.
const url = process.env["CLICKHOUSE_URL"];
const reachable = url
  ? await fetch(new URL("/ping", url), { signal: AbortSignal.timeout(500) })
      .then((response) => response.ok)
      .catch(() => false)
  : false;

const scope = { orgId: randomUUID(), workspaceId: randomUUID() };
const root = randomUUID();
const child = randomUUID();
const ROOT_WINDOW = "system=2000:1;tools=6000:18;conversation=12000:40";
const CHILD_WINDOW = "system=500:1;conversation=1500:4";

/** One frame, every column not named here left at its default. */
function frame(
  session: string,
  seq: number,
  columns: Record<string, unknown>,
  over: { workspaceId?: string } = {},
) {
  const ts = `2026-09-26 10:00:${String(seq).padStart(2, "0")}.000`;
  return {
    org_id: scope.orgId,
    workspace_id: over.workspaceId ?? scope.workspaceId,
    session_uuid: session,
    root_session_uuid: root,
    seq,
    ts,
    received_at: ts,
    chain_verified: true,
    ...columns,
  };
}

const FRAMES = [
  frame(root, 1, { kind: "tool_call", tool_name: "Read" }),
  frame(root, 2, {
    kind: "llm_call",
    model: "claude-opus-5",
    provider: "anthropic",
    request_id: "req_2",
    input_tokens: 1311,
    cache_read_tokens: 40022,
    cache_creation_tokens: 667,
    attrs: {
      "oxagen.window": ROOT_WINDOW,
      "oxagen.llm_call_duplicate_of": "otel_log",
      "oxagen.request_digest": `sha256:${"a".repeat(64)}`,
    },
  }),
  // A call the transcript reported, with no window.
  frame(root, 3, { kind: "llm_call", model: "claude-opus-5", attrs: {} }),
  frame(child, 4, {
    kind: "llm_call",
    model: "claude-haiku-5",
    provider: "anthropic",
    request_id: "req_4",
    input_tokens: 2000,
    attrs: { "oxagen.window": CHILD_WINDOW },
  }),
  // The same root in another workspace of the organization.
  frame(
    root,
    5,
    {
      kind: "llm_call",
      model: "claude-opus-5",
      input_tokens: 9,
      attrs: { "oxagen.window": ROOT_WINDOW },
    },
    { workspaceId: randomUUID() },
  ),
];

async function readAll(sessionUuids: readonly string[]) {
  const rows: TachoWindowFrameRow[] = [];
  await readTachoWindowFrames(
    { ...scope, rootSessionUuid: root, sessionUuids },
    async (batch) => {
      rows.push(...batch);
    },
  );
  return rows;
}

describe.skipIf(!reachable)("the run window read on ClickHouse", () => {
  beforeAll(async () => {
    await clickhouse().insert({
      table: "tacho_events",
      format: "JSONEachRow",
      values: FRAMES,
    });
  });
  afterAll(async () => {
    await closeClickhouse();
  });

  it("reads every chain's windowed model calls, oldest first, with the usage columns", async () => {
    const rows = await readAll([root, child]);
    expect(rows).toEqual([
      {
        seq: 2,
        kind: "llm_call",
        attrs: {
          "oxagen.window": ROOT_WINDOW,
          "oxagen.llm_call_duplicate_of": "otel_log",
        },
        model: "claude-opus-5",
        provider: "anthropic",
        requestId: "req_2",
        inputTokens: 1311,
        cacheReadTokens: 40022,
        cacheCreationTokens: 667,
        body: "",
      },
      {
        seq: 4,
        kind: "llm_call",
        attrs: { "oxagen.window": CHILD_WINDOW },
        model: "claude-haiku-5",
        provider: "anthropic",
        requestId: "req_4",
        inputTokens: 2000,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        body: "",
      },
    ]);
  });

  it("reads the root's chain when the list leaves it out, and no unlisted chain (negative)", async () => {
    const rows = await readAll([]);
    expect(rows.map((row) => row.seq)).toEqual([2]);
  });

  it("reads the family through its root when the list is too long for the URL", async () => {
    // More sessions than ten array parameters carry, so the read names the
    // chains by the run's root instead of sending the list.
    const many = [
      root,
      child,
      ...Array.from({ length: 10_001 }, () => randomUUID()),
    ];
    const rows = await readAll(many);
    expect(rows.map((row) => row.seq)).toEqual([2, 4]);
  });
});
