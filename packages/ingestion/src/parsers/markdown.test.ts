import { describe, it, expect } from "vitest";
import { parseMarkdown } from "./markdown";

describe("parseMarkdown", () => {
  it("creates one symbol per ATX heading with its section body", () => {
    const md = [
      "# Title",
      "Intro paragraph.",
      "",
      "## Section A",
      "Body of A.",
      "",
      "## Section B",
      "Body of B.",
    ].join("\n");

    const { title, symbols } = parseMarkdown(md);
    expect(title).toBe("Title");
    expect(symbols.map((s) => s.name)).toEqual(["Title", "Section A", "Section B"]);
    expect(symbols.every((s) => s.kind === "heading")).toBe(true);

    const sectionA = symbols.find((s) => s.name === "Section A")!;
    expect(sectionA.code).toContain("Body of A.");
    expect(sectionA.docComment).toContain("Body of A.");
    expect(sectionA.signature).toBe("## Section A");
  });

  it("ends a section at the next same-or-higher level heading", () => {
    const md = [
      "## Parent",
      "p",
      "### Child",
      "c",
      "## Sibling",
      "s",
    ].join("\n");
    const { symbols } = parseMarkdown(md);
    const parent = symbols.find((s) => s.name === "Parent")!;
    const child = symbols.find((s) => s.name === "Child")!;
    // Parent's range extends across its child subsection (ends before Sibling).
    expect(parent.code).toContain("Child");
    expect(parent.code).toContain("c");
    expect(parent.code).not.toContain("Sibling");
    // Child is its own section.
    expect(child.code).toContain("c");
    expect(child.code).not.toContain("Sibling");
  });

  it("ignores '#' lines inside fenced code blocks", () => {
    const md = [
      "# Real Heading",
      "```bash",
      "# this is a shell comment, not a heading",
      "echo hi",
      "```",
      "## Another Real Heading",
    ].join("\n");
    const { symbols } = parseMarkdown(md);
    expect(symbols.map((s) => s.name)).toEqual(["Real Heading", "Another Real Heading"]);
  });

  it("falls back to the first heading as title when there is no H1", () => {
    const { title, symbols } = parseMarkdown("## First\nbody");
    expect(title).toBe("First");
    expect(symbols).toHaveLength(1);
  });

  it("returns no symbols for heading-less content", () => {
    const { title, symbols } = parseMarkdown("just a paragraph\nand another line");
    expect(symbols).toHaveLength(0);
    expect(title).toBeUndefined();
  });
});
