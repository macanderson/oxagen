import { describe, it, expect } from "vitest";
import { markdownToPlainText } from "./markdown-preview";

describe("markdownToPlainText", () => {
  it("returns an empty string for empty input", () => {
    expect(markdownToPlainText("")).toBe("");
  });

  it("strips heading markers", () => {
    expect(markdownToPlainText("# Title\n## Sub")).toBe("Title Sub");
  });

  it("keeps fenced code content but drops the fences and language hint", () => {
    expect(markdownToPlainText("```ts\nconst a = 1;\n```")).toContain(
      "const a = 1;",
    );
    expect(markdownToPlainText("```ts\nconst a = 1;\n```")).not.toContain(
      "```",
    );
  });

  it("unwraps inline code", () => {
    expect(markdownToPlainText("use `foo()` here")).toBe("use foo() here");
  });

  it("reduces images to their alt text", () => {
    expect(markdownToPlainText("![a diagram](/x.png)")).toBe("a diagram");
  });

  it("reduces links to their text", () => {
    expect(markdownToPlainText("see [the docs](https://x.y)")).toBe(
      "see the docs",
    );
  });

  it("strips blockquote and list markers", () => {
    expect(markdownToPlainText("> quoted")).toBe("quoted");
    expect(markdownToPlainText("- one\n- two")).toBe("one two");
    expect(markdownToPlainText("1. first\n2. second")).toBe("first second");
  });

  it("removes bold, italic and strikethrough markers", () => {
    expect(markdownToPlainText("**bold** and *italic* and ~~gone~~")).toBe(
      "bold and italic and gone",
    );
    expect(markdownToPlainText("__b__ and _i_")).toBe("b and i");
  });

  it("removes horizontal rules", () => {
    expect(markdownToPlainText("above\n\n---\n\nbelow")).toBe("above below");
  });

  it("flattens table pipes and separator rows", () => {
    const table = "| a | b |\n| - | - |\n| 1 | 2 |";
    const out = markdownToPlainText(table);
    expect(out).not.toContain("|");
    expect(out).toContain("a");
    expect(out).toContain("2");
  });

  it("collapses whitespace runs to single spaces and trims", () => {
    expect(markdownToPlainText("  a\n\n\n   b   ")).toBe("a b");
  });
});
