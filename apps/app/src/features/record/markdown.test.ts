// The statement editor's pure parts: the markdown scanner, the edits Tab and
// Enter make, Find, the caret's line and column, and how a procedure's
// statement splits into steps.
import { describe, expect, it } from "vitest";
import { procedureSteps } from "./kind-panel";
import { tokenizeMarkdown } from "./markdown";
import { caretAt, findAll, indent, newline } from "./statement-editor";

describe("tokenizeMarkdown", () => {
  it("gives back the source exactly when its tokens are joined", () => {
    const source =
      "# Heading\n> a quote\n- item with `code`\n1. **bold** step\n```\nfenced\n```\nplain";
    const joined = tokenizeMarkdown(source)
      .map((line) => line.map((token) => token.text).join(""))
      .join("\n");
    expect(joined).toBe(source);
  });

  it("names each construct", () => {
    const kinds = tokenizeMarkdown(
      "# Title\n> said\n- a `b` **c**\n```\nx\n```",
    ).map((line) => line.map((token) => token.kind));
    expect(kinds).toEqual([
      ["heading"],
      ["quote"],
      ["marker", "text", "code", "text", "strong"],
      ["fence"],
      ["code"],
      ["fence"],
    ]);
  });

  it("reads a plain sentence as one text token", () => {
    expect(tokenizeMarkdown("A person merges it.")).toEqual([
      [{ kind: "text", text: "A person merges it." }],
    ]);
  });
});

describe("the editor's edits", () => {
  it("inserts two spaces at the caret on Tab", () => {
    expect(indent("abc", 1, 1, false)).toEqual({
      value: "a  bc",
      start: 3,
      end: 3,
    });
  });

  it("indents and outdents every line of a multi-line selection", () => {
    const value = "one\ntwo\nthree";
    const inward = indent(value, 0, 7, false);
    expect(inward.value).toBe("  one\n  two\nthree");
    expect(indent(inward.value, 0, 11, true).value).toBe(value);
  });

  it("continues a numbered list on Enter with the next number", () => {
    const value = "1. Freeze main";
    expect(newline(value, value.length, value.length)).toEqual({
      value: "1. Freeze main\n2. ",
      start: 18,
      end: 18,
    });
  });

  it("keeps a bullet and the indent on Enter", () => {
    const value = "  - item";
    expect(newline(value, value.length, value.length).value).toBe(
      "  - item\n  - ",
    );
    expect(newline("plain", 5, 5).value).toBe("plain\n");
  });

  it("finds every match without case, and nothing for an empty query", () => {
    expect(findAll("Read, re-read, READ", "read")).toEqual([0, 9, 15]);
    expect(findAll("anything", "")).toEqual([]);
  });

  it("reports Ln and Col from one", () => {
    expect(caretAt("ab\ncd", 0)).toEqual({ line: 1, col: 1 });
    expect(caretAt("ab\ncd", 4)).toEqual({ line: 2, col: 2 });
  });
});

describe("procedureSteps", () => {
  it("splits a sentence after its colon on commas and then", () => {
    expect(
      procedureSteps(
        "Cut a release in this order: freeze main, dry-run the migrations, tag, then publish the notes.",
      ),
    ).toEqual([
      "Freeze main",
      "Dry-run the migrations",
      "Tag",
      "Publish the notes",
    ]);
  });

  it("splits numbered lines on their numbers", () => {
    expect(
      procedureSteps("1. reproduce\n2. bisect\n3) open the issue"),
    ).toEqual(["Reproduce", "Bisect", "Open the issue"]);
  });

  it("has no steps for no statement", () => {
    expect(procedureSteps(null)).toEqual([]);
    expect(procedureSteps("  ")).toEqual([]);
  });
});
