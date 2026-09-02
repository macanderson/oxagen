import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted so the mock fn exists when the vi.mock factory runs. We mock ONLY
// extractMemoriesFromDocument and keep the real mapWithConcurrency, so the
// handler's concurrency/fan-out logic is exercised for real.
const mocks = vi.hoisted(() => ({
  extractMock: vi.fn(),
}));

vi.mock("../memory/import", async (importActual) => {
  const actual = await importActual<typeof import("../memory/import")>();
  return { ...actual, extractMemoriesFromDocument: mocks.extractMock };
});

import { agentMemoryImportParseHandler } from "./agent.memory_import.parse";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

function doc(filename: string, content = "some content") {
  return { filename, content };
}

describe("agent.memory.import.parse handler", () => {
  beforeEach(() => {
    mocks.extractMock.mockReset();
  });

  it("flattens extracted memories from all documents into drafts", async () => {
    mocks.extractMock.mockImplementation(
      async ({ filename }: { filename: string }) => {
        if (filename === "a.md") {
          return [
            {
              lesson: "Lesson A1",
              memoryClass: "OBSERVATION",
              memoryKind: "constraint",
            },
          ];
        }
        return [
          {
            lesson: "Lesson B1",
            memoryClass: "OBSERVATION",
            memoryKind: "gotcha",
          },
          {
            lesson: "Lesson B2",
            memoryClass: "RULE",
            memoryKind: "routine-change",
            enforcementScore: 60,
          },
        ];
      },
    );

    const out = await agentMemoryImportParseHandler(
      { documents: [doc("a.md"), doc("b.md")] },
      CTX,
    );

    expect(out.drafts).toHaveLength(3);
    expect(out.documentCount).toBe(2);
    expect(out.skipped).toEqual([]);
    // Every draft carries source "user", classified true, and its source document.
    expect(out.drafts.every((d) => d.source === "user")).toBe(true);
    expect(out.drafts.every((d) => d.classified === true)).toBe(true);
    expect(
      out.drafts.find((d) => d.lesson === "Lesson A1")?.sourceDocument,
    ).toBe("a.md");
    expect(out.drafts.find((d) => d.lesson === "Lesson B2")?.memoryClass).toBe(
      "RULE",
    );
    expect(
      out.drafts.find((d) => d.lesson === "Lesson B2")?.enforcementScore,
    ).toBe(60);
  });

  it("anchors drafts to the default nodeRef when supplied", async () => {
    mocks.extractMock.mockResolvedValue([
      { lesson: "L", memoryClass: "OBSERVATION", memoryKind: "constraint" },
    ]);
    const out = await agentMemoryImportParseHandler(
      { documents: [doc("a.md")], defaultNodeRef: "team:platform" },
      CTX,
    );
    expect(out.drafts[0]?.nodeRef).toBe("team:platform");
  });

  it("defaults the nodeRef to 'user-memory' when none is supplied", async () => {
    mocks.extractMock.mockResolvedValue([
      { lesson: "L", memoryClass: "OBSERVATION", memoryKind: "constraint" },
    ]);
    const out = await agentMemoryImportParseHandler(
      { documents: [doc("a.md")] },
      CTX,
    );
    expect(out.drafts[0]?.nodeRef).toBe("user-memory");
  });

  it("trims a blank default nodeRef back to the 'user-memory' bucket", async () => {
    mocks.extractMock.mockResolvedValue([
      { lesson: "L", memoryClass: "OBSERVATION", memoryKind: "constraint" },
    ]);
    const out = await agentMemoryImportParseHandler(
      { documents: [doc("a.md")], defaultNodeRef: "   " },
      CTX,
    );
    expect(out.drafts[0]?.nodeRef).toBe("user-memory");
  });

  it("records a document that yields no memories as skipped (not a draft)", async () => {
    mocks.extractMock.mockImplementation(
      async ({ filename }: { filename: string }) =>
        filename === "empty.md"
          ? []
          : [
              {
                lesson: "Real",
                memoryClass: "OBSERVATION",
                memoryKind: "gotcha",
              },
            ],
    );
    const out = await agentMemoryImportParseHandler(
      { documents: [doc("empty.md"), doc("good.md")] },
      CTX,
    );
    expect(out.drafts).toHaveLength(1);
    expect(out.documentCount).toBe(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]?.filename).toBe("empty.md");
  });

  it("records a document whose extraction throws as skipped, without failing the batch", async () => {
    mocks.extractMock.mockImplementation(
      async ({ filename }: { filename: string }) => {
        if (filename === "bad.md") throw new Error("model exploded");
        return [
          {
            lesson: "Survivor",
            memoryClass: "OBSERVATION",
            memoryKind: "constraint",
          },
        ];
      },
    );
    const out = await agentMemoryImportParseHandler(
      { documents: [doc("bad.md"), doc("ok.md")] },
      CTX,
    );
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]?.lesson).toBe("Survivor");
    expect(out.skipped).toEqual([
      { filename: "bad.md", reason: "model exploded" },
    ]);
  });

  it("returns empty drafts + all-skipped when no document yields memories", async () => {
    mocks.extractMock.mockResolvedValue([]);
    const out = await agentMemoryImportParseHandler(
      { documents: [doc("a.md"), doc("b.md")] },
      CTX,
    );
    expect(out.drafts).toEqual([]);
    expect(out.documentCount).toBe(0);
    expect(out.skipped).toHaveLength(2);
  });
});
