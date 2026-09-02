import { describe, expect, it } from "vitest";
import { markdownGenerate } from "./markdown.generate";

describe("markdown.generate capability", () => {
  // ── Input parsing ────────────────────────────────────────────────────────────

  it("parses a minimal valid input (title + markdown)", () => {
    const parsed = markdownGenerate.input.parse({
      title: "My Document",
      markdown: "# Hello\n\nWorld.",
    });
    expect(parsed.title).toBe("My Document");
    expect(parsed.markdown).toBe("# Hello\n\nWorld.");
    expect(parsed.sections).toBeUndefined();
  });

  it("parses an input with only title (no markdown, no sections)", () => {
    const parsed = markdownGenerate.input.parse({ title: "Empty Doc" });
    expect(parsed.title).toBe("Empty Doc");
    expect(parsed.markdown).toBeUndefined();
    expect(parsed.sections).toBeUndefined();
  });

  it("parses an input with sections fallback instead of markdown", () => {
    const parsed = markdownGenerate.input.parse({
      title: "Structured Doc",
      sections: [
        {
          heading: "Introduction",
          paragraphs: ["First paragraph.", "Second paragraph."],
        },
        { paragraphs: ["No heading section."] },
      ],
    });
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections?.[0]?.heading).toBe("Introduction");
    expect(parsed.sections?.[0]?.paragraphs).toEqual([
      "First paragraph.",
      "Second paragraph.",
    ]);
    expect(parsed.sections?.[1]?.heading).toBeUndefined();
  });

  it("parses an input with both markdown and sections (both are optional)", () => {
    const parsed = markdownGenerate.input.parse({
      title: "Full",
      markdown: "# Hello",
      sections: [{ paragraphs: ["Ignored when markdown is present."] }],
    });
    expect(parsed.markdown).toBe("# Hello");
    expect(parsed.sections).toHaveLength(1);
  });

  it("rejects an empty title", () => {
    expect(() =>
      markdownGenerate.input.parse({ title: "", markdown: "# Hi" }),
    ).toThrow();
  });

  it("rejects a section with zero paragraphs", () => {
    expect(() =>
      markdownGenerate.input.parse({
        title: "Bad",
        sections: [{ heading: "H1", paragraphs: [] }],
      }),
    ).toThrow();
  });

  // ── Output parsing ───────────────────────────────────────────────────────────

  it("parses a valid output shape", () => {
    const parsed = markdownGenerate.output.parse({
      assetId: "asset-uuid-md",
      publicId: "gen_MDTEST",
      kind: "markdown",
      mimeType: "text/markdown",
      sizeBytes: 512,
      url: "https://blob.example.com/doc.md",
      serveUrl: "/api/v1/assets/gen_MDTEST",
      render: {
        componentId: "file-attachment",
        props: {
          url: "/api/v1/assets/gen_MDTEST",
          name: "My Document.md",
          kind: "markdown",
          mimeType: "text/markdown",
          sizeBytes: 512,
        },
      },
    });

    expect(parsed.assetId).toBe("asset-uuid-md");
    expect(parsed.publicId).toBe("gen_MDTEST");
    expect(parsed.kind).toBe("markdown");
    expect(parsed.mimeType).toBe("text/markdown");
    expect(parsed.sizeBytes).toBe(512);
    expect(parsed.render.componentId).toBe("file-attachment");
    expect(parsed.render.props.kind).toBe("markdown");
    expect(parsed.render.props.name).toBe("My Document.md");
  });

  it("rejects an output with a wrong kind value", () => {
    expect(() =>
      markdownGenerate.output.parse({
        assetId: "x",
        publicId: "gen_X",
        kind: "document", // not 'markdown'
        mimeType: "text/markdown",
        sizeBytes: 100,
        url: "https://example.com/x",
        serveUrl: "/api/v1/assets/gen_X",
        render: {
          componentId: "file-attachment",
          props: {
            url: "/x",
            name: "x.md",
            kind: "markdown",
            mimeType: "text/markdown",
            sizeBytes: 100,
          },
        },
      }),
    ).toThrow();
  });

  it("rejects an output missing required fields", () => {
    expect(() => markdownGenerate.output.parse({ assetId: "x" })).toThrow();
  });

  it("rejects a render directive with a wrong componentId", () => {
    expect(() =>
      markdownGenerate.output.parse({
        assetId: "x",
        publicId: "gen_X",
        kind: "markdown",
        mimeType: "text/markdown",
        sizeBytes: 100,
        url: "https://example.com/x",
        serveUrl: "/api/v1/assets/gen_X",
        render: {
          componentId: "video-preview", // wrong
          props: {
            url: "/x",
            name: "x.md",
            kind: "markdown",
            mimeType: "text/markdown",
            sizeBytes: 100,
          },
        },
      }),
    ).toThrow();
  });

  // ── Capability metadata ──────────────────────────────────────────────────────

  it("has the correct capability name", () => {
    expect(markdownGenerate.name).toBe("generate_markdown");
  });

  it("surfaces include api, mcp, and agent", () => {
    expect(markdownGenerate.surfaces).toContain("api");
    expect(markdownGenerate.surfaces).toContain("mcp");
    expect(markdownGenerate.surfaces).toContain("agent");
  });

  it("is workspace-scoped", () => {
    expect(markdownGenerate.scoped).toBe(true);
  });

  it("has low risk level", () => {
    expect(markdownGenerate.agent?.riskLevel).toBe("low");
  });
});
