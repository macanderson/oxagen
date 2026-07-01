/**
 * Unit tests for createPlatformMemoryProvider.
 *
 * recallMemories, writeMemory, and embedText are mocked to avoid live
 * Neo4j / AI gateway calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mocks ─────────────────────────────────────────────────────────────────────

const { recallMemories, writeMemory, embedText } = vi.hoisted(() => ({
  recallMemories: vi.fn(),
  writeMemory: vi.fn(),
  embedText: vi.fn(),
}));

vi.mock("../../memory/neo4j", () => ({ recallMemories, writeMemory }));
vi.mock("../../memory/embed", () => ({ embedText }));

import { createPlatformMemoryProvider } from "../memory-provider";

// ── fixtures ──────────────────────────────────────────────────────────────────

const TELEMETRY = {
  orgId: "org-uuid-1",
  workspaceId: "ws-uuid-1",
  surface: "agent" as const,
  messageId: "msg-uuid-1",
};

const FAKE_EMBEDDING = [0.1, 0.2, 0.3];

beforeEach(() => {
  recallMemories.mockReset();
  writeMemory.mockReset();
  embedText.mockReset();
  embedText.mockResolvedValue(FAKE_EMBEDDING);
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("createPlatformMemoryProvider — recallContext", () => {
  it("formats recalled memories as '- [memoryKind] lesson'", async () => {
    recallMemories.mockResolvedValueOnce([
      { memoryKind: "constraint", lesson: "always use strict mode", score: 0.9 },
      { memoryKind: "preference", lesson: "prefer functional style", score: 0.8 },
    ]);

    const provider = createPlatformMemoryProvider({ recallQuery: "foo", telemetry: TELEMETRY });
    const result = await provider.recallContext();

    expect(result).toBe("- [constraint] always use strict mode\n- [preference] prefer functional style");
    expect(embedText).toHaveBeenCalledWith("foo", expect.objectContaining({
      telemetry: expect.objectContaining({ orgId: "org-uuid-1" }),
    }));
    expect(recallMemories).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: FAKE_EMBEDDING, limit: 8, recallThreshold: 0.7 }),
    );
    // No class/enforcement filter — coding-turn recall wants the broadest context.
    const arg = recallMemories.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.memoryClass).toBeUndefined();
    expect(arg.minEnforcement).toBeUndefined();
  });

  it("returns empty string when no memories match", async () => {
    recallMemories.mockResolvedValueOnce([]);

    const provider = createPlatformMemoryProvider({ recallQuery: "bar", telemetry: TELEMETRY });
    const result = await provider.recallContext();

    expect(result).toBe("");
  });
});

describe("createPlatformMemoryProvider — remember", () => {
  it("embeds and writes an OBSERVATION memory with the two-axis shape", async () => {
    writeMemory.mockResolvedValueOnce({ memoryId: "m1", edgesCreated: 0 });

    const provider = createPlatformMemoryProvider({ recallQuery: "q", telemetry: TELEMETRY });
    await provider.remember("coding_turn", { instruction: "fix the bug", changedFiles: ["a.ts"] });

    expect(embedText).toHaveBeenCalledOnce();
    expect(writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeRef: "coding-agent",
        memoryClass: "OBSERVATION",
        memoryKind: "coding_turn",
        source: "coding-agent",
        createdByKind: "AGENT",
        createdById: "coding-agent",
        embedding: FAKE_EMBEDDING,
      }),
    );
  });

  it("does not throw when writeMemory rejects", async () => {
    writeMemory.mockRejectedValueOnce(new Error("Neo4j unavailable"));

    const provider = createPlatformMemoryProvider({ recallQuery: "q", telemetry: TELEMETRY });
    // must not throw
    await expect(
      provider.remember("coding_turn", { instruction: "test" }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when embedText rejects", async () => {
    embedText.mockRejectedValueOnce(new Error("AI gateway down"));

    const provider = createPlatformMemoryProvider({ recallQuery: "q", telemetry: TELEMETRY });
    await expect(
      provider.remember("coding_turn", { instruction: "test" }),
    ).resolves.toBeUndefined();
  });
});

describe("createPlatformMemoryProvider — close", () => {
  it("is a no-op that resolves", async () => {
    const provider = createPlatformMemoryProvider({ recallQuery: "q", telemetry: TELEMETRY });
    await expect(provider.close?.()).resolves.toBeUndefined();
  });
});
