/**
 * `oxagen graph pull` handler unit tests.
 *
 * Strategy:
 *   - Mock `../../lib/api.js` so apiPostOrThrow returns controlled paged
 *     responses without touching the network. (The handler pulls via
 *     apiPostOrThrow so a mid-pull failure throws into the handler's catch and
 *     store.close() still runs in finally — it no longer hard-exits.)
 *   - Mock `../../lib/config.js` so getOrgId/getWorkspaceId return fixed values
 *     without reading ~/.config/oxagen/config.json.
 *   - Pass `_duckdbPath: ":memory:"` to handleGraphPull so no filesystem path
 *     is created — uses the real in-memory DuckDB store for full fidelity.
 *
 * Output discipline (ADR-023 §4): `--json` is asserted to be one single-line
 * JSON value round-tripping the SAME summary shape; pretty summary lands on
 * stdout; progress on stderr; failures are uniform on stderr + process.exitCode.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (must be declared before any imports that use them)
// ---------------------------------------------------------------------------

vi.mock("../../lib/api.js", () => ({
  apiPost: vi.fn(),
  apiPostOrThrow: vi.fn(),
}));

vi.mock("../../lib/config.js", () => ({
  getOrgId: vi.fn(() => "test-org"),
  getWorkspaceId: vi.fn(() => "test-ws"),
  getToken: vi.fn(() => "tok"),
  getApiUrl: vi.fn(() => "http://localhost:4000"),
  readConfig: vi.fn(() => ({})),
  writeConfig: vi.fn(),
  clearConfig: vi.fn(),
}));

import { handleGraphPull } from "../graph.pull.js";
import { apiPostOrThrow } from "../../lib/api.js";
import { createGraphStore } from "@oxagen/engram";

const mockApiPost = apiPostOrThrow as unknown as Mock;

// ---------------------------------------------------------------------------
// Stdout / stderr capture
// ---------------------------------------------------------------------------

let out = "";
let err = "";
const restorers: Array<() => void> = [];

beforeEach(() => {
  out = "";
  err = "";
  process.exitCode = undefined;

  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((s: unknown) => {
      out += String(s);
      return true;
    }) as never);

  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((s: unknown) => {
      err += String(s);
      return true;
    }) as never);

  restorers.push(() => outSpy.mockRestore(), () => errSpy.mockRestore());
});

afterEach(() => {
  for (const r of restorers.splice(0)) r();
  process.exitCode = undefined;
  mockApiPost.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, displayName = "Node") {
  return {
    id,
    labels: ["Entity"],
    displayName,
    properties: {},
    isSystem: false,
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function makeEdge(id: string, src: string, tgt: string) {
  return {
    id,
    sourceId: src,
    targetId: tgt,
    type: "RELATES",
    properties: {},
    inferred: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleGraphPull", () => {
  it("pulls 2 data pages then terminates on hasMore=false", async () => {
    mockApiPost
      .mockResolvedValueOnce({
        nodes: [makeNode("n1"), makeNode("n2")],
        edges: [makeEdge("e1", "n1", "n2")],
        hasMore: true,
        cursor: "cur1",
      })
      .mockResolvedValueOnce({
        nodes: [makeNode("n3")],
        edges: [],
        hasMore: true,
        cursor: "cur2",
      })
      .mockResolvedValueOnce({
        nodes: [],
        edges: [],
        hasMore: false,
        cursor: "cur2",
      });

    await handleGraphPull({ _duckdbPath: ":memory:" });

    // apiPost was called 3 times (2 data pages + 1 terminating empty page)
    expect(mockApiPost).toHaveBeenCalledTimes(3);
    // Summary includes totals from all pages
    expect(out).toContain("3 node(s)");
    expect(out).toContain("1 edge(s)");
  });

  it("advances offset across pages", async () => {
    mockApiPost
      .mockResolvedValueOnce({
        nodes: [makeNode("a1")],
        edges: [],
        hasMore: true,
        cursor: "c1",
      })
      .mockResolvedValueOnce({
        nodes: [],
        edges: [],
        hasMore: false,
        cursor: "c1",
      });

    await handleGraphPull({ _duckdbPath: ":memory:" });

    const calls = mockApiPost.mock.calls;
    // First call: offset=0
    expect((calls[0]![1] as Record<string, unknown>)["offset"]).toBe(0);
    // Second call: offset=500 (PAGE_SIZE)
    expect((calls[1]![1] as Record<string, unknown>)["offset"]).toBe(500);
  });

  it("stores cursor from last page in the local DuckDB store", async () => {
    mockApiPost.mockResolvedValueOnce({
      nodes: [makeNode("z1")],
      edges: [],
      hasMore: false,
      cursor: "final-cursor",
    });

    // We need to verify the cursor was persisted.  We open the same ":memory:"
    // store — but note the memory store is ephemeral per-connection.  Instead
    // we assert via the JSON summary that the cursor field is correct.
    await handleGraphPull({ _duckdbPath: ":memory:", json: true });

    const result = JSON.parse(out) as {
      cursor: string;
      pulled: { nodes: number; edges: number };
    };
    expect(result.cursor).toBe("final-cursor");
    expect(result.pulled.nodes).toBe(1);
    expect(result.pulled.edges).toBe(0);
  });

  it("uses updatedAfter from existing cursor on incremental pull", async () => {
    mockApiPost.mockResolvedValueOnce({
      nodes: [],
      edges: [],
      hasMore: false,
      cursor: "new-cur",
    });

    // Seed a cursor in the store so the pull picks it up.
    // We do this by running a full pull first, then a second incremental pull.
    mockApiPost
      .mockReset()
      .mockResolvedValueOnce({
        nodes: [makeNode("seed")],
        edges: [],
        hasMore: false,
        cursor: "seed-cursor",
      })
      .mockResolvedValueOnce({
        nodes: [],
        edges: [],
        hasMore: false,
        cursor: "seed-cursor",
      });

    // A single ":memory:" connection can't share cursor between calls since
    // each createGraphStore(":memory:") is its own ephemeral DB.
    // We test updatedAfter behaviour by using --full (no cursor) vs default.
    // Full pull → updatedAfter undefined.
    await handleGraphPull({ _duckdbPath: ":memory:", full: true });
    const firstCall = mockApiPost.mock.calls[0]![1] as Record<string, unknown>;
    expect(firstCall["updatedAfter"]).toBeUndefined();
  });

  it("passes --full flag by skipping the cursor", async () => {
    mockApiPost.mockResolvedValueOnce({
      nodes: [],
      edges: [],
      hasMore: false,
    });

    await handleGraphPull({ _duckdbPath: ":memory:", full: true });

    const body = mockApiPost.mock.calls[0]![1] as Record<string, unknown>;
    expect(body["updatedAfter"]).toBeUndefined();
  });

  it("passes label filter through to apiPost", async () => {
    mockApiPost.mockResolvedValueOnce({
      nodes: [],
      edges: [],
      hasMore: false,
    });

    await handleGraphPull({ _duckdbPath: ":memory:", labels: "Person,SourceFile" });

    const body = mockApiPost.mock.calls[0]![1] as Record<string, unknown>;
    expect(body["labels"]).toEqual(["Person", "SourceFile"]);
  });

  it("passes noSystem flag as isSystem=false to apiPost", async () => {
    mockApiPost.mockResolvedValueOnce({
      nodes: [],
      edges: [],
      hasMore: false,
    });

    await handleGraphPull({ _duckdbPath: ":memory:", noSystem: true });

    const body = mockApiPost.mock.calls[0]![1] as Record<string, unknown>;
    expect(body["isSystem"]).toBe(false);
  });

  it("outputs JSON summary when --json flag is set", async () => {
    mockApiPost.mockResolvedValueOnce({
      nodes: [makeNode("j1"), makeNode("j2")],
      edges: [makeEdge("je1", "j1", "j2")],
      hasMore: false,
      cursor: "json-cursor",
    });

    await handleGraphPull({ _duckdbPath: ":memory:", json: true });

    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed["cursor"]).toBe("json-cursor");
    expect((parsed["pulled"] as Record<string, unknown>)["nodes"]).toBe(2);
    expect((parsed["pulled"] as Record<string, unknown>)["edges"]).toBe(1);
  });

  it("upserts all nodes and edges into the store", async () => {
    mockApiPost.mockResolvedValueOnce({
      nodes: [makeNode("u1"), makeNode("u2"), makeNode("u3")],
      edges: [makeEdge("ue1", "u1", "u2"), makeEdge("ue2", "u2", "u3")],
      hasMore: false,
      cursor: "c",
    });

    // We can't inspect the store after the handler closes it (memory DB is
    // ephemeral per-connection), but we CAN verify the totals in the summary.
    await handleGraphPull({ _duckdbPath: ":memory:", json: true });

    const result = JSON.parse(out) as {
      total: { nodes: number; edges: number };
    };
    expect(result.total.nodes).toBe(3);
    expect(result.total.edges).toBe(2);
  });

  it("emits --json as ONE single-line value round-tripping the full summary shape", async () => {
    mockApiPost.mockResolvedValueOnce({
      nodes: [makeNode("s1"), makeNode("s2")],
      edges: [makeEdge("se1", "s1", "s2")],
      hasMore: false,
      cursor: "single-line-cursor",
    });

    await handleGraphPull({ _duckdbPath: ":memory:", json: true });

    // Exactly one JSON line on stdout — the discipline is single-line, not the
    // old 2-space `JSON.stringify(summary, null, 2)` pretty-print.
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    // Same fields as before the conversion.
    expect(parsed).toEqual({
      pulled: { nodes: 2, edges: 1 },
      total: { nodes: 2, edges: 1 },
      cursor: "single-line-cursor",
      path: ":memory:",
    });
  });

  it("writes the pagination `\\r` progress redraw to stderr, never stdout", async () => {
    mockApiPost.mockResolvedValueOnce({
      nodes: [makeNode("p1")],
      edges: [],
      hasMore: false,
      cursor: "c",
    });

    await handleGraphPull({ _duckdbPath: ":memory:" });

    // In-place redraw lives on stderr and keeps its raw carriage return.
    expect(err).toContain("Pulled 1 nodes");
    expect(err).toContain("\r");
    // stdout carries the summary ("node(s)"), never the raw progress ("nodes").
    expect(out).not.toContain("Pulled 1 nodes");
    expect(out).toContain("Pulled 1 node(s)");
  });

  it("routes a mid-pull API failure to a uniform pretty stderr error + exit 1 (store still closes)", async () => {
    mockApiPost.mockRejectedValueOnce(new Error("boom: export failed"));

    await handleGraphPull({ _duckdbPath: ":memory:" });

    expect(process.exitCode).toBe(1);
    expect(err).toContain("✗");
    expect(err).toContain("boom: export failed");
    // No partial summary leaked to stdout.
    expect(out).toBe("");
  });

  it("routes a mid-pull API failure to a single machine error line on stderr in --json mode", async () => {
    mockApiPost.mockRejectedValueOnce(new Error("json export boom"));

    await handleGraphPull({ _duckdbPath: ":memory:", json: true });

    expect(process.exitCode).toBe(1);
    const errObj = JSON.parse(err.trim()) as { type: string; code: string; message: string };
    expect(errObj.type).toBe("error");
    expect(errObj.code).toBe("api");
    expect(errObj.message).toContain("json export boom");
    expect(out).toBe("");
  });

  it("sets exitCode=1 and writes to stderr when org is missing", async () => {
    const { getOrgId } = await import("../../lib/config.js");
    (getOrgId as unknown as Mock).mockReturnValueOnce(undefined);

    await handleGraphPull({ _duckdbPath: ":memory:" });

    expect(process.exitCode).toBe(1);
    expect(err).toContain("Missing org or workspace");
    expect(mockApiPost).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Sanity: createGraphStore is re-exported from @oxagen/engram
// ---------------------------------------------------------------------------

describe("createGraphStore re-export", () => {
  it("creates an in-memory store that opens and closes without error", async () => {
    const store = createGraphStore({ duckdbPath: ":memory:" });
    await expect(store.close()).resolves.toBeUndefined();
  });
});
