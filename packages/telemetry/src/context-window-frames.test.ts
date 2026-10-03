/**
 * Unit tests for `readTachoWindowFrames` (#5341) over a fake client: which
 * plane it reads, how a row maps, how the rows are batched, and that the
 * result is closed. The SQL
 * runs against a real table in ./context-window-frames.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, planeClient } = vi.hoisted(() => {
  const query = vi.fn();
  return { query, planeClient: vi.fn(async () => ({ query })) };
});

vi.mock("./tenant", () => ({ planeClient }));

import {
  readTachoWindowFrames,
  type TachoWindowFrameRow,
} from "./context-window-frames";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const ROOT = "0192d4a8-7c1e-7a00-8000-00000000c0de";
const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c0df";
const WINDOW = "system=100:1;conversation=900:4";

/** One row as ClickHouse returns it, every column a string or null. */
function dbRow(seq: number, over: Record<string, unknown> = {}) {
  return {
    seq: String(seq),
    window_attr: WINDOW,
    duplicate_of: "",
    model: "claude-opus-5",
    provider: "anthropic",
    request_id: `req_${String(seq)}`,
    input_tokens: "40",
    cache_read_tokens: "900",
    cache_creation_tokens: null,
    ...over,
  };
}

/** A result whose stream yields `pages`, then throws `fail` when given. */
function result(pages: unknown[][], fail?: Error) {
  const close = vi.fn();
  return {
    close,
    stream: async function* () {
      for (const page of pages) yield page.map((row) => ({ json: () => row }));
      if (fail !== undefined) throw fail;
    },
  };
}

async function readAll(sessionUuids: readonly string[] = [ROOT, CHILD]) {
  const batches: TachoWindowFrameRow[][] = [];
  await readTachoWindowFrames(
    { ...SCOPE, rootSessionUuid: ROOT, sessionUuids },
    async (rows) => {
      batches.push(rows);
    },
  );
  return batches;
}

beforeEach(() => {
  query.mockReset();
  planeClient.mockClear();
});

describe("readTachoWindowFrames", () => {
  it("maps each row to the shape tachoContextWindow decodes", async () => {
    const res = result([
      [dbRow(2), dbRow(3, { duplicate_of: "otel_log", provider: "" })],
    ]);
    query.mockResolvedValue(res);
    const [batch] = await readAll();
    expect(batch).toEqual([
      {
        seq: 2,
        kind: "llm_call",
        attrs: { "oxagen.window": WINDOW },
        model: "claude-opus-5",
        provider: "anthropic",
        requestId: "req_2",
        inputTokens: 40,
        cacheReadTokens: 900,
        cacheCreationTokens: null,
        body: "",
      },
      {
        seq: 3,
        kind: "llm_call",
        attrs: {
          "oxagen.window": WINDOW,
          "oxagen.llm_call_duplicate_of": "otel_log",
        },
        model: "claude-opus-5",
        provider: "",
        requestId: "req_3",
        inputTokens: 40,
        cacheReadTokens: 900,
        cacheCreationTokens: null,
        body: "",
      },
    ]);
    expect(res.close).toHaveBeenCalledTimes(1);
  });

  it("reads a negative or fractional count as not reported, never as a number (negative)", async () => {
    query.mockResolvedValue(
      result([
        [
          dbRow(2, {
            input_tokens: "-5",
            cache_read_tokens: "12.5",
            cache_creation_tokens: -1,
          }),
        ],
      ]),
    );
    const [batch] = await readAll();
    expect(batch?.[0]).toMatchObject({
      inputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });

  it("hands the rows over 256 at a time, the rest in a last batch", async () => {
    const rows = Array.from({ length: 257 }, (_, i) => dbRow(i));
    // The client's pages do not line up with the batches.
    query.mockResolvedValue(result([rows.slice(0, 100), rows.slice(100)]));
    const batches = await readAll();
    expect(batches.map((batch) => batch.length)).toEqual([256, 1]);
    expect(batches[1]?.[0]?.seq).toBe(256);
  });

  it("hands over no batch when no row carries a window (negative)", async () => {
    query.mockResolvedValue(result([]));
    expect(await readAll()).toEqual([]);
  });

  it("reads the organization's own plane and names the run's scope, root and chains, the root first when the list leaves it out", async () => {
    query.mockResolvedValue(result([]));
    await readAll([CHILD]);
    expect(planeClient).toHaveBeenCalledWith(SCOPE.orgId);
    const [args] = query.mock.calls[0] as [
      { query: string; query_params: Record<string, unknown> },
    ];
    expect(args.query_params).toMatchObject({
      ...SCOPE,
      rootSessionUuid: ROOT,
      sessionUuids: [ROOT, CHILD],
      windowAttr: "oxagen.window",
      duplicateAttr: "oxagen.llm_call_duplicate_of",
    });
    expect(args.query).toContain("kind = 'llm_call'");
    expect(args.query).toContain("attrs[{windowAttr:String}] != ''");
  });

  it("closes the result and throws when the stream fails, so the rollup retries", async () => {
    const res = result([[dbRow(2)]], new Error("socket hang up"));
    query.mockResolvedValue(res);
    await expect(readAll()).rejects.toThrow("socket hang up");
    expect(res.close).toHaveBeenCalledTimes(1);
  });
});
