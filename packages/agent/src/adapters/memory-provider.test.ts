import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the Neo4j memory layer and embedder so the adapter can be tested without
// a live graph or gateway. Only the calls exercised by recallContext matter.
const neo4j = vi.hoisted(() => ({
  recallMemories: vi.fn(),
  recallPeerResults: vi.fn(),
  writeMemory: vi.fn(),
  recordExecution: vi.fn(),
  recordCitation: vi.fn(),
}));
vi.mock("../memory/neo4j", () => ({
  recallMemories: neo4j.recallMemories,
  recallPeerResults: neo4j.recallPeerResults,
  writeMemory: neo4j.writeMemory,
  recordExecution: neo4j.recordExecution,
  recordCitation: neo4j.recordCitation,
}));

const embed = vi.hoisted(() => ({ embedText: vi.fn(async () => [0.1, 0.2, 0.3]) }));
vi.mock("../memory/embed", () => ({ embedText: embed.embedText }));

// Capture the module-level pino logger so the peer-recall failure path can be
// asserted (recall must continue without peer lines AND log a warning).
const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("pino", () => ({ default: () => loggerMock }));

import { createPlatformMemoryProvider } from "./memory-provider";

function makeProvider() {
  return createPlatformMemoryProvider({
    recallQuery: "fix the login bug",
    telemetry: {
      orgId: "org_1",
      workspaceId: "ws_1",
      // null messageId → the auto-citation block is skipped, isolating the
      // peer-recall path under test.
      messageId: null,
      surface: "agent",
    },
  });
}

describe("createPlatformMemoryProvider.recallContext — peer recall failure", () => {
  beforeEach(() => {
    embed.embedText.mockClear();
    neo4j.recallMemories.mockReset();
    neo4j.recallPeerResults.mockReset();
    loggerMock.warn.mockClear();
  });

  it("logs a warning and continues without peer lines when peer recall rejects", async () => {
    neo4j.recallMemories.mockResolvedValue([
      {
        id: "m1",
        memoryKind: "gotcha",
        lesson: "always validate input",
        enforcementScore: 90,
        confidenceScore: 80,
      },
    ]);
    neo4j.recallPeerResults.mockRejectedValue(new Error("neo4j peer query down"));

    const provider = makeProvider();
    const out = await provider.recallContext();

    // No throw — the memory line survives, no peer lines are appended.
    expect(out).toBe("- [gotcha] always validate input");
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("peer recall failed"),
    );
  });

  it("appends peer lines when peer recall succeeds", async () => {
    neo4j.recallMemories.mockResolvedValue([]);
    neo4j.recallPeerResults.mockResolvedValue([
      { summary: "prior run fixed a similar bug", runId: "run-9" },
    ]);

    const provider = makeProvider();
    const out = await provider.recallContext();

    expect(out).toBe("- [peer-result] prior run fixed a similar bug (run run-9)");
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
