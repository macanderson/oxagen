import { describe, expect, it } from "vitest";
import {
  fileParts,
  firstSentence,
  isIndexFile,
  labelOf,
  lineageOf,
  policySlug,
  slugPart,
  uniqueLineage,
} from "./naming";

describe("slugPart and fileParts", () => {
  it("makes lowercase hyphenated slugs", () => {
    expect(slugPart("Release Checklist!")).toBe("release-checklist");
    expect(slugPart("Café  déjà vu")).toBe("cafe-deja-vu");
    expect(slugPart("---")).toBe("");
  });

  it("takes the folders and the name without its extension", () => {
    expect(fileParts("docs/Release Checklist.md")).toEqual(["docs", "release-checklist"]);
    expect(fileParts(".cursor/rules/style.mdc")).toEqual(["cursor", "rules", "style"]);
    expect(fileParts("CLAUDE.md")).toEqual(["claude"]);
    expect(fileParts("a\\b\\c.markdown")).toEqual(["a", "b", "c"]);
  });

  it("names a policy file for its Markdown file", () => {
    expect(policySlug("policies/No branch delete.md")).toBe("no-branch-delete");
    expect(policySlug("!!!.md")).toBe("policy");
  });

  it("knows a README or index file", () => {
    expect(isIndexFile("docs/README.md")).toBe(true);
    expect(isIndexFile("index.mdx")).toBe(true);
    expect(isIndexFile("docs/readme-notes.md")).toBe(false);
  });
});

describe("lineageOf and uniqueLineage", () => {
  it("joins the parts with dots", () => {
    expect(lineageOf(["a-intel", "docs", "release", "Tag the release"])).toBe(
      "a-intel.docs.release.tag-the-release",
    );
  });

  it("stops at a part boundary before 120 characters", () => {
    const long = lineageOf(["a-intel", ...Array.from({ length: 10 }, () => "x".repeat(30))]);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith("x")).toBe(true);
  });

  it("falls back when nothing valid is left (negative)", () => {
    expect(lineageOf(["a-intel"])).toBe("a-intel.imported");
    expect(lineageOf(["", "!!"])).toBe("import.imported");
  });

  it("numbers a lineage already taken", () => {
    const taken = new Set(["a.b"]);
    expect(uniqueLineage("a.b", taken)).toBe("a.b-2");
    expect(uniqueLineage("a.b", taken)).toBe("a.b-3");
    expect(uniqueLineage("a.c", taken)).toBe("a.c");
    expect(taken.has("a.b-3")).toBe(true);
  });
});

describe("labelOf and firstSentence", () => {
  it("fits the proposed label to 36 characters", () => {
    expect(labelOf("No push to main", "x")).toBe("No push to main");
    expect(labelOf("A label that is much longer than the thirty-six cap", "x").length).toBeLessThanOrEqual(36);
  });

  it("falls back to the statement's first words", () => {
    expect(labelOf(null, "**Never** push to main.")).toBe("Never push to main.");
    expect(labelOf("  ", "")).toBe("Imported record");
  });

  it("takes the first sentence, cut at a word", () => {
    expect(firstSentence("Tag the release. Then publish the notes.")).toBe("Tag the release.");
    expect(firstSentence("no full stop here")).toBe("no full stop here");
    const cut = firstSentence(`${"word ".repeat(60)}end.`, 50);
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(cut.endsWith("word")).toBe(true);
  });
});
