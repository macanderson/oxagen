import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the transport so recallMemories()'s request body can be asserted without
// hitting the network. Hoisted above the import of memory-client.
const { apiPostOrThrow } = vi.hoisted(() => ({ apiPostOrThrow: vi.fn() }));
vi.mock("../api.js", () => ({ apiPostOrThrow }));

import { recallMemories } from "../memory-client.js";

describe("recallMemories transport", () => {
  beforeEach(() => {
    apiPostOrThrow.mockReset();
    apiPostOrThrow.mockResolvedValue({ memories: [] });
  });

  it("POSTs to agent/memory/recall with query, default limit, execution ref, and agent id", async () => {
    await recallMemories({
      query: "fix the login bug",
      executionRef: "cli:one-shot-42",
      agentId: "coding-agent",
    });
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/recall",
      expect.objectContaining({
        query: "fix the login bug",
        limit: 6,
        executionRef: "cli:one-shot-42",
        agentId: "coding-agent",
      }),
    );
  });

  it("forwards an explicit limit and optional class/enforcement filters", async () => {
    await recallMemories({
      query: "auth",
      limit: 3,
      memoryClass: "RULE",
      minEnforcement: 80,
      nodeRef: "Function:auth#validate",
    });
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/recall",
      expect.objectContaining({
        limit: 3,
        memoryClass: "RULE",
        minEnforcement: 80,
        nodeRef: "Function:auth#validate",
      }),
    );
  });

  it("returns the memories array from the response verbatim", async () => {
    const row = {
      id: "m1",
      nodeRef: "coding-agent",
      memoryClass: "RULE" as const,
      memoryKind: "gotcha",
      lesson: "Use withTenantDb, never raw db().",
      source: "fix",
      confidenceScore: 91,
      enforcementScore: 95,
      score: 0.88,
      createdAt: "2026-07-01T00:00:00Z",
    };
    apiPostOrThrow.mockResolvedValue({ memories: [row] });
    const res = await recallMemories({ query: "db access" });
    expect(res.memories).toEqual([row]);
  });
});
