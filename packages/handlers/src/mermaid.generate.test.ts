import { describe, it, expect, vi } from "vitest";

// Mock logger — we don't test log output
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { mermaidGenerateHandler } from "./mermaid.generate";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const VALID_DIAGRAM = "flowchart TD\n  A[Start] --> B[End]";

describe("mermaidGenerateHandler", () => {
  it("returns title, source, and render directive on success", async () => {
    const result = await mermaidGenerateHandler(
      { title: "My Flow", diagram: VALID_DIAGRAM },
      CTX,
    );

    expect(result.title).toBe("My Flow");
    expect(result.source).toBe(VALID_DIAGRAM);
    expect(result.render.componentId).toBe("mermaid-diagram");
    expect(result.render.props["source"]).toBe(VALID_DIAGRAM);
    expect(result.render.props["title"]).toBe("My Flow");
    expect(result.render.props["theme"]).toBe("default");
  });

  it("passes through an explicit theme", async () => {
    const result = await mermaidGenerateHandler(
      { title: "Dark Chart", diagram: VALID_DIAGRAM, theme: "dark" },
      CTX,
    );
    expect(result.render.props["theme"]).toBe("dark");
  });

  it("defaults theme to 'default' when not provided", async () => {
    const result = await mermaidGenerateHandler(
      { title: "T", diagram: VALID_DIAGRAM },
      CTX,
    );
    expect(result.render.props["theme"]).toBe("default");
  });

  it("throws when diagram is blank whitespace", async () => {
    await expect(
      mermaidGenerateHandler({ title: "T", diagram: "   " }, CTX),
    ).rejects.toThrow("blank");
  });

  it("throws when diagram exceeds 50,000 characters", async () => {
    await expect(
      mermaidGenerateHandler({ title: "T", diagram: "A".repeat(50_001) }, CTX),
    ).rejects.toThrow("50000");
  });

  it("accepts a diagram of exactly 50,000 characters", async () => {
    const longDiagram = "A".repeat(50_000);
    const result = await mermaidGenerateHandler({ title: "T", diagram: longDiagram }, CTX);
    expect(result.source).toBe(longDiagram);
  });

  it("passes source through unchanged", async () => {
    const source = "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi";
    const result = await mermaidGenerateHandler({ title: "Seq", diagram: source }, CTX);
    expect(result.source).toBe(source);
  });
});
