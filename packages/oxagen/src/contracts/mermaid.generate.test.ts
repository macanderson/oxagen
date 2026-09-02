import { describe, expect, it } from "vitest";
import { mermaidGenerate } from "./mermaid.generate";

describe("mermaid.generate capability", () => {
  it("parses a minimal valid input", () => {
    const parsed = mermaidGenerate.input.parse({
      title: "Simple Flowchart",
      diagram: "flowchart TD\n  A --> B",
    });
    expect(parsed.title).toBe("Simple Flowchart");
    expect(parsed.diagram).toBe("flowchart TD\n  A --> B");
    expect(parsed.theme).toBeUndefined();
  });

  it("parses a full input with all optional fields", () => {
    const parsed = mermaidGenerate.input.parse({
      title: "Auth Sequence",
      diagram: "sequenceDiagram\n  Alice->>Bob: Hello",
      theme: "dark",
    });
    expect(parsed.title).toBe("Auth Sequence");
    expect(parsed.theme).toBe("dark");
  });

  it("accepts all valid theme values", () => {
    for (const theme of ["default", "dark", "neutral", "forest"] as const) {
      const parsed = mermaidGenerate.input.parse({
        title: "T",
        diagram: "flowchart TD\n  A --> B",
        theme,
      });
      expect(parsed.theme).toBe(theme);
    }
  });

  it("rejects an empty title", () => {
    expect(() =>
      mermaidGenerate.input.parse({
        title: "",
        diagram: "flowchart TD\n  A --> B",
      }),
    ).toThrow();
  });

  it("rejects an empty diagram", () => {
    expect(() =>
      mermaidGenerate.input.parse({ title: "Chart", diagram: "" }),
    ).toThrow();
  });

  it("rejects a diagram exceeding 50,000 characters", () => {
    expect(() =>
      mermaidGenerate.input.parse({
        title: "Big",
        diagram: "A".repeat(50_001),
      }),
    ).toThrow();
  });

  it("rejects an invalid theme value", () => {
    expect(() =>
      mermaidGenerate.input.parse({
        title: "T",
        diagram: "graph TD",
        theme: "light",
      }),
    ).toThrow();
  });

  it("parses a valid output with render directive", () => {
    const source = "flowchart TD\n  A --> B";
    const out = mermaidGenerate.output.parse({
      title: "My Diagram",
      source,
      render: {
        componentId: "mermaid-diagram",
        props: { source, title: "My Diagram", theme: "default" },
      },
    });
    expect(out.title).toBe("My Diagram");
    expect(out.source).toBe(source);
    expect(out.render.componentId).toBe("mermaid-diagram");
  });

  it("rejects output with empty source", () => {
    expect(() =>
      mermaidGenerate.output.parse({
        title: "T",
        source: "",
        render: { componentId: "mermaid-diagram", props: {} },
      }),
    ).toThrow();
  });

  it("has the expected contract metadata", () => {
    expect(mermaidGenerate.name).toBe("generate_mermaid");
    expect(mermaidGenerate.surfaces).toContain("api");
    expect(mermaidGenerate.surfaces).toContain("mcp");
    expect(mermaidGenerate.surfaces).toContain("agent");
    expect(mermaidGenerate.sensitivity).toBe("low");
    expect(mermaidGenerate.defaultEffect).toBe("deny");
    expect(mermaidGenerate.agent?.requiresApproval).toBe(false);
    expect(mermaidGenerate.agent?.riskLevel).toBe("low");
  });
});
