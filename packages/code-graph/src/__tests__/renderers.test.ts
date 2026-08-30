/**
 * Tests for renderMarkdownFileText (@oxagen/code-graph/renderers).
 *
 * renderFileText is exercised indirectly through its callers elsewhere in the
 * codebase, so this file covers the markdown-specific renderer only.
 */
import { describe, it, expect } from "vitest";
import { renderMarkdownFileText } from "../renderers";

describe("renderMarkdownFileText", () => {
  it("includes the full content for a short doc", () => {
    const text = renderMarkdownFileText({
      path: "docs/guide.md",
      content: "# Guide\n\nThis is a short doc about widgets.",
    });

    expect(text).toContain("docs/guide.md");
    expect(text).toContain("This is a short doc about widgets.");
  });

  it("carries content well past the first 1500 characters (unlike renderFileText's head slice)", () => {
    // Build a doc where the distinctive marker sits after char 1500 — a plain
    // content.slice(0, 1500) would never see it.
    const filler = "Lorem ipsum dolor sit amet. ".repeat(80); // ~2320 chars
    const marker = "UNIQUE_MARKER_DEEP_IN_DOCUMENT";
    const content = `# Title\n\n${filler}\n\n${marker}\n\nmore text after the marker.`;
    expect(filler.length).toBeGreaterThan(1500);

    const text = renderMarkdownFileText({ path: "docs/long.md", content });

    expect(text).toContain(marker);
  });

  it("caps total output at maxChars (default budget)", () => {
    const content = "word ".repeat(5000); // 25,000 chars
    const text = renderMarkdownFileText({ path: "docs/huge.md", content });

    // path + separator + body, so allow a small fixed overhead over the cap.
    expect(text.length).toBeLessThan(6000 + "docs/huge.md".length + 10);
  });

  it("respects a custom maxChars", () => {
    const content = "word ".repeat(5000);
    const text = renderMarkdownFileText({
      path: "docs/huge.md",
      content,
      maxChars: 200,
    });

    expect(text.length).toBeLessThan(200 + "docs/huge.md".length + 10);
  });

  it("always includes at least the first chunk, even if it alone exceeds maxChars", () => {
    const content = "x".repeat(500);
    const text = renderMarkdownFileText({
      path: "a.md",
      content,
      maxChars: 10,
    });

    // Truncated to the cap, but never empty.
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("a.md");
  });

  it("returns just the path for empty content, without throwing", () => {
    const text = renderMarkdownFileText({ path: "empty.md", content: "" });
    expect(text).toBe("empty.md");
  });

  it("includes an optional title for orientation", () => {
    const text = renderMarkdownFileText({
      path: "docs/api.md",
      content: "Some body text.",
      title: "API Reference",
    });
    expect(text).toContain("API Reference");
  });
});
