import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the Neo4j-backed ontology layer so the adapter can be exercised without
// a live graph. `scopedSession` yields a fake session; `recordExecutionInGraph`
// is a spy we can force to reject.
const onto = vi.hoisted(() => ({
  run: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  recordExecutionInGraph: vi.fn(async () => undefined),
}));
vi.mock("@oxagen/ontology", () => ({
  scopedSession: () => ({ run: onto.run, close: onto.close }),
  recordExecutionInGraph: onto.recordExecutionInGraph,
}));

// Capture the module-level pino logger to assert the dropped-write is surfaced.
const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("pino", () => ({ default: () => loggerMock }));

import { createGraphSyncAdapter } from "./graph-sync";

describe("createGraphSyncAdapter — non-throwing degrade", () => {
  beforeEach(() => {
    onto.run.mockReset().mockResolvedValue(undefined);
    onto.close.mockReset().mockResolvedValue(undefined);
    onto.recordExecutionInGraph.mockReset().mockResolvedValue(undefined);
    loggerMock.warn.mockClear();
  });

  it("ensureGraph resolves (does not reject) and logs when the Neo4j run fails", async () => {
    onto.run.mockRejectedValueOnce(new Error("neo4j unreachable"));
    const adapter = createGraphSyncAdapter({ owner: "oxageninc", repo: "oxagen-platform" });

    await expect(adapter.ensureGraph(["src/a.ts"])).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fileCount: 1 }),
      expect.stringContaining("ensureGraph failed"),
    );
    // Session is still closed on the error path.
    expect(onto.close).toHaveBeenCalledTimes(1);
  });

  it("recordLineage resolves (does not reject) and logs when the graph write fails", async () => {
    onto.recordExecutionInGraph.mockRejectedValueOnce(new Error("neo4j unreachable"));
    const adapter = createGraphSyncAdapter({ owner: "oxageninc", repo: "oxagen-platform" });

    await expect(
      adapter.recordLineage({ executionId: "exec-1", touchedFiles: ["src/a.ts"] }),
    ).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: "exec-1", fileCount: 1 }),
      expect.stringContaining("recordLineage failed"),
    );
  });

  it("both methods no-op (and never log) when there are no touched files", async () => {
    const adapter = createGraphSyncAdapter();
    await expect(adapter.ensureGraph([])).resolves.toBeUndefined();
    await expect(
      adapter.recordLineage({ executionId: "exec-1", touchedFiles: [] }),
    ).resolves.toBeUndefined();
    expect(onto.run).not.toHaveBeenCalled();
    expect(onto.recordExecutionInGraph).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
