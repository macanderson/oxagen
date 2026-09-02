import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted so all mock fns exist when vi.mock factories run. We keep the real
// mapWithConcurrency (../memory/import is NOT mocked) so the handler's fan-out
// is exercised; only the persistence/embedding/runtime deps are mocked.
const mocks = vi.hoisted(() => ({
  writeMemoryMock: vi.fn(),
  embedTextMock: vi.fn(),
  isKnowledgeGraphEnabledMock: vi.fn(),
}));

vi.mock("../memory/neo4j", () => ({ writeMemory: mocks.writeMemoryMock }));
vi.mock("../memory/embed", () => ({ embedText: mocks.embedTextMock }));
vi.mock("../runtime/knowledge-graph", () => ({
  isKnowledgeGraphEnabled: mocks.isKnowledgeGraphEnabledMock,
}));

import { agentMemoryImportCommitHandler } from "./agent.memory_import.commit";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

function draft(overrides: Record<string, unknown> = {}) {
  return {
    lesson: "Never push to main.",
    memoryClass: "RULE" as const,
    memoryKind: "constraint",
    enforcementScore: 95,
    source: "user",
    nodeRef: "user-memory",
    sourceDocument: "rules.md",
    classified: true,
    ...overrides,
  };
}

describe("agent.memory.import.commit handler", () => {
  beforeEach(() => {
    mocks.writeMemoryMock.mockReset();
    mocks.embedTextMock.mockReset();
    mocks.isKnowledgeGraphEnabledMock.mockReset();
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(true);
    mocks.embedTextMock.mockImplementation(async () =>
      new Array(1536).fill(0.05),
    );
    let n = 0;
    mocks.writeMemoryMock.mockImplementation(async () => ({
      memoryId: `m_${++n}`,
      edgesCreated: 0,
    }));
  });

  it("writes every draft and returns positional success results", async () => {
    const out = await agentMemoryImportCommitHandler(
      { drafts: [draft({ lesson: "A" }), draft({ lesson: "B" })] },
      CTX,
    );
    expect(out.imported).toBe(2);
    expect(out.failed).toBe(0);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({
      lesson: "A",
      ok: true,
      error: null,
    });
    expect(out.results[0]?.memoryId).toMatch(/^m_/);
    expect(mocks.writeMemoryMock).toHaveBeenCalledTimes(2);
    expect(mocks.embedTextMock).toHaveBeenCalledTimes(2);
  });

  it("passes memoryClass, memoryKind, enforcementScore, lesson, nodeRef, and source through to writeMemory", async () => {
    await agentMemoryImportCommitHandler(
      {
        drafts: [
          draft({
            lesson: "Anchored lesson",
            memoryClass: "OBSERVATION",
            memoryKind: "gotcha",
            enforcementScore: undefined,
            nodeRef: "Function:auth#login",
            source: "imported-rules",
          }),
        ],
      },
      CTX,
    );
    const arg = mocks.writeMemoryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg).toMatchObject({
      lesson: "Anchored lesson",
      memoryClass: "OBSERVATION",
      memoryKind: "gotcha",
      enforcementScore: null,
      nodeRef: "Function:auth#login",
      source: "imported-rules",
      createdByKind: "AGENT",
      createdById: "imported-rules",
    });
    expect(Array.isArray(arg.embedding)).toBe(true);
  });

  it("defaults nodeRef, source, and memoryClass when a draft omits them (invoke skips schema defaults)", async () => {
    await agentMemoryImportCommitHandler(
      // Hand-construct a draft missing the defaulted fields, as a raw invoke()
      // caller might.
      { drafts: [{ lesson: "L", memoryKind: "constraint" } as never] },
      CTX,
    );
    const arg = mocks.writeMemoryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.nodeRef).toBe("user-memory");
    expect(arg.source).toBe("user");
    expect(arg.memoryClass).toBe("OBSERVATION");
    expect(arg.enforcementScore).toBeNull();
  });

  it("captures per-item failures without aborting the batch", async () => {
    mocks.writeMemoryMock
      .mockImplementationOnce(async () => ({
        memoryId: "m_ok",
        edgesCreated: 0,
      }))
      .mockImplementationOnce(async () => {
        throw new Error("neo4j write timeout");
      })
      .mockImplementationOnce(async () => ({
        memoryId: "m_ok3",
        edgesCreated: 0,
      }));

    const out = await agentMemoryImportCommitHandler(
      {
        drafts: [
          draft({ lesson: "A" }),
          draft({ lesson: "B" }),
          draft({ lesson: "C" }),
        ],
      },
      CTX,
    );
    expect(out.imported).toBe(2);
    expect(out.failed).toBe(1);
    // Positional: results[1] is the failure.
    expect(out.results[1]).toMatchObject({
      lesson: "B",
      ok: false,
      memoryId: null,
      error: "neo4j write timeout",
    });
    expect(out.results[0]?.ok).toBe(true);
    expect(out.results[2]?.ok).toBe(true);
  });

  it("captures a class-invariant violation as a per-item failure (RULE draft with no enforcementScore)", async () => {
    const out = await agentMemoryImportCommitHandler(
      {
        drafts: [
          draft({
            lesson: "A",
            memoryClass: "RULE",
            enforcementScore: undefined,
          }),
        ],
      },
      CTX,
    );
    expect(out.failed).toBe(1);
    expect(out.results[0]).toMatchObject({ ok: false, memoryId: null });
    expect(out.results[0]?.error).toMatch(/RULE requires enforcement_score/);
    expect(mocks.writeMemoryMock).not.toHaveBeenCalled();
  });

  it("captures embedding failures per item", async () => {
    mocks.embedTextMock
      .mockImplementationOnce(async () => {
        throw new Error("embedding gateway down");
      })
      .mockImplementation(async () => new Array(1536).fill(0.05));

    const out = await agentMemoryImportCommitHandler(
      { drafts: [draft({ lesson: "A" }), draft({ lesson: "B" })] },
      CTX,
    );
    expect(out.results[0]).toMatchObject({
      ok: false,
      error: "embedding gateway down",
    });
    expect(out.failed).toBe(1);
    expect(out.imported).toBe(1);
  });

  it("reports every draft as failed when the knowledge graph is not configured", async () => {
    mocks.isKnowledgeGraphEnabledMock.mockReturnValue(false);
    const out = await agentMemoryImportCommitHandler(
      { drafts: [draft({ lesson: "A" }), draft({ lesson: "B" })] },
      CTX,
    );
    expect(out.imported).toBe(0);
    expect(out.failed).toBe(2);
    expect(out.results.every((r) => !r.ok && r.memoryId === null)).toBe(true);
    expect(out.results[0]?.error).toMatch(/not configured/i);
    // Nothing is embedded or written when the graph is off.
    expect(mocks.embedTextMock).not.toHaveBeenCalled();
    expect(mocks.writeMemoryMock).not.toHaveBeenCalled();
  });
});
