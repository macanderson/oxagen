import { describe, expect, it } from "vitest";
import { svgGenerate } from "./svg.generate";

describe("svg.generate capability", () => {
  it("parses a minimal valid input", () => {
    const parsed = svgGenerate.input.parse({ prompt: "A simple circle" });
    expect(parsed.prompt).toBe("A simple circle");
    expect(parsed.title).toBeUndefined();
    expect(parsed.width).toBeUndefined();
    expect(parsed.height).toBeUndefined();
  });

  it("parses a full input with all optional fields", () => {
    const parsed = svgGenerate.input.parse({
      prompt: "A brand gradient ring",
      title: "Oxagen Ring",
      width: 512,
      height: 512,
    });
    expect(parsed.title).toBe("Oxagen Ring");
    expect(parsed.width).toBe(512);
    expect(parsed.height).toBe(512);
  });

  it("rejects an empty prompt", () => {
    expect(() => svgGenerate.input.parse({ prompt: "" })).toThrow();
  });

  it("rejects a non-positive width", () => {
    expect(() =>
      svgGenerate.input.parse({ prompt: "test", width: 0 }),
    ).toThrow();
  });

  it("rejects a negative height", () => {
    expect(() =>
      svgGenerate.input.parse({ prompt: "test", height: -1 }),
    ).toThrow();
  });

  it("parses a valid output with render directive", () => {
    const out = svgGenerate.output.parse({
      svg: '<svg viewBox="0 0 400 400"></svg>',
      title: "Test SVG",
      render: {
        componentId: "svg-preview",
        props: { svg: '<svg viewBox="0 0 400 400"></svg>', title: "Test SVG" },
      },
    });
    expect(out.svg).toContain("<svg");
    expect(out.title).toBe("Test SVG");
    expect(out.render.componentId).toBe("svg-preview");
  });

  it("rejects output with empty svg", () => {
    expect(() =>
      svgGenerate.output.parse({
        svg: "",
        title: "Empty",
        render: { componentId: "svg-preview", props: {} },
      }),
    ).toThrow();
  });

  it("has the expected contract metadata", () => {
    expect(svgGenerate.name).toBe("generate_svg");
    expect(svgGenerate.surfaces).toContain("api");
    expect(svgGenerate.surfaces).toContain("mcp");
    expect(svgGenerate.surfaces).toContain("agent");
    expect(svgGenerate.sensitivity).toBe("low");
    expect(svgGenerate.defaultEffect).toBe("deny");
  });
});
