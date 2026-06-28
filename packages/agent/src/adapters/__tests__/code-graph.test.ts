/**
 * Unit tests for createNeo4jCodeGraphProvider.
 *
 * scopedSession is mocked so the tests run without a live Neo4j instance.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  scopedSession: vi.fn(),
}));

vi.mock("@oxagen/ontology", () => ({
  scopedSession: mocks.scopedSession,
}));

mocks.scopedSession.mockReturnValue({ run: mocks.run, close: mocks.close });

import { createNeo4jCodeGraphProvider } from "../code-graph";

// ── helpers ───────────────────────────────────────────────────────────────────

type FieldMap = Record<string, unknown>;

function makeRecord(fields: FieldMap) {
  return { get: (k: string) => fields[k] };
}

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mocks.run.mockReset();
  mocks.close.mockReset();
  mocks.close.mockResolvedValue(undefined);
  mocks.scopedSession.mockReturnValue({ run: mocks.run, close: mocks.close });
});

describe("createNeo4jCodeGraphProvider — search", () => {
  it("formats results as <fileNaturalKey>:<startLine>: <kind> <name>", async () => {
    const provider = createNeo4jCodeGraphProvider();

    // First call: SourceSymbol results; second: SourceFile results
    mocks.run
      .mockResolvedValueOnce({
        records: [
          makeRecord({
            name: "MyClass",
            kind: "class",
            fileNaturalKey: "src/foo.ts",
            startLine: 10,
          }),
        ],
      })
      .mockResolvedValueOnce({
        records: [
          makeRecord({
            name: "src/bar.ts",
            kind: "file",
            fileNaturalKey: "src/bar.ts",
            startLine: 0,
          }),
        ],
      });

    const result = await provider.query("search", "foo");

    expect(result).toContain("src/foo.ts:10: class MyClass");
    expect(result).toContain("src/bar.ts:0: file src/bar.ts");
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("closes the session on success", async () => {
    mocks.run
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [] });

    await createNeo4jCodeGraphProvider().query("search", "x");

    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("returns error string (never throws) when Neo4j run rejects", async () => {
    mocks.run.mockRejectedValueOnce(new Error("connection refused"));

    const result = await createNeo4jCodeGraphProvider().query("search", "x");

    expect(result).toMatch(/code graph query error/);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});

describe("createNeo4jCodeGraphProvider — file_symbols", () => {
  it("formats symbol results correctly", async () => {
    mocks.run.mockResolvedValueOnce({
      records: [
        makeRecord({
          name: "doSomething",
          kind: "function",
          fileNaturalKey: "src/utils.ts",
          startLine: 42,
        }),
      ],
    });

    const result = await createNeo4jCodeGraphProvider().query("file_symbols", "utils");

    expect(result).toContain("src/utils.ts:42: function doSomething");
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("returns empty string when no symbols match", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });

    const result = await createNeo4jCodeGraphProvider().query("file_symbols", "nope");

    expect(result).toBe("");
  });
});

describe("createNeo4jCodeGraphProvider — dependents / imports", () => {
  it("returns the not-available string for dependents without touching Neo4j", async () => {
    const result = await createNeo4jCodeGraphProvider().query("dependents", "foo");

    expect(result).toMatch(/not available/);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("returns the not-available string for imports without touching Neo4j", async () => {
    const result = await createNeo4jCodeGraphProvider().query("imports", "foo");

    expect(result).toMatch(/not available/);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
