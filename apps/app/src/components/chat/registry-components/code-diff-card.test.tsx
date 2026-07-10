// @vitest-environment jsdom
/**
 * code-diff-card.test.tsx
 *
 * Covers:
 *   - parseUnifiedDiff: hunk headers, add/del/context lines, no-newline marker
 *   - countDiffStats: additions/deletions tally
 *   - diffAnchorId: deterministic, URL-safe anchor ids
 *   - CodeDiffCard render: file count, totals, per-file sections, copy button,
 *     missing-patch fallback, external link, empty state
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  within,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import CodeDiffCard, {
  classifyChange,
  countDiffStats,
  parseTokenStyle,
  parseUnifiedDiff,
  splitPath,
} from "./code-diff-card";
import { diffAnchorId } from "./diff-anchor";

afterEach(cleanup);

// Deterministic, synchronous syntax-highlight stub: the real Shiki highlighter
// needs WASM and is exercised in diff-syntax.test.ts. Here we assert the card
// WIRES tokens into `.diff-token` spans carrying the dual-theme style.
vi.mock("./diff-syntax", () => ({
  inferLang: (path: string) =>
    path.endsWith(".ts") ? "typescript" : "plaintext",
  highlightLine: async (line: string, lang: string) =>
    lang === "plaintext" || line.length === 0
      ? [{ content: line }]
      : [{ content: line, style: "color:#111;--shiki-dark:#eee" }],
}));

const SAMPLE_PATCH = [
  "@@ -1,3 +1,4 @@",
  " function greet() {",
  "-  console.log('hi');",
  "+  console.log('hello');",
  "+  console.log('world');",
  " }",
  "\\ No newline at end of file",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("parses a single hunk with add/del/context lines", () => {
    const hunks = parseUnifiedDiff(SAMPLE_PATCH);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.header).toBe("@@ -1,3 +1,4 @@");
    expect(hunks[0]?.lines.map((l) => l.type)).toEqual([
      "context",
      "del",
      "add",
      "add",
      "context",
    ]);
  });

  it("tracks old/new line numbers across add/del/context", () => {
    const hunks = parseUnifiedDiff(SAMPLE_PATCH);
    const lines = hunks[0]?.lines ?? [];
    expect(lines[0]).toMatchObject({ type: "context", oldLine: 1, newLine: 1 });
    expect(lines[1]).toMatchObject({ type: "del", oldLine: 2, newLine: null });
    expect(lines[2]).toMatchObject({ type: "add", oldLine: null, newLine: 2 });
  });

  it("ignores the 'no newline at end of file' marker", () => {
    const hunks = parseUnifiedDiff(SAMPLE_PATCH);
    const markers = hunks[0]?.lines.filter((l) =>
      l.content.includes("No newline"),
    );
    expect(markers).toHaveLength(0);
  });

  it("skips pre-hunk file headers (---/+++)", () => {
    const patch = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const hunks = parseUnifiedDiff(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines).toHaveLength(2);
  });

  it("returns no hunks for an empty patch", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("handles multiple hunks", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "@@ -10,1 +10,1 @@",
      "-c",
      "+d",
    ].join("\n");
    expect(parseUnifiedDiff(patch)).toHaveLength(2);
  });
});

describe("countDiffStats", () => {
  it("counts additions and deletions across hunks", () => {
    const hunks = parseUnifiedDiff(SAMPLE_PATCH);
    expect(countDiffStats(hunks)).toEqual({ additions: 2, deletions: 1 });
  });

  it("returns zero for a diff with only context lines", () => {
    const hunks = parseUnifiedDiff("@@ -1,1 +1,1 @@\n unchanged");
    expect(countDiffStats(hunks)).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("diffAnchorId", () => {
  it("prefixes and URL-encodes the path", () => {
    expect(diffAnchorId("src/index.ts")).toBe("diff-src%2Findex.ts");
  });
});

describe("CodeDiffCard", () => {
  it("renders the empty state when there are no files", () => {
    render(<CodeDiffCard files={[]} />);
    expect(screen.getByText("No files changed.")).toBeInTheDocument();
  });

  it("renders file count and per-file path", () => {
    render(
      <CodeDiffCard
        files={[
          { path: "src/a.ts", patch: SAMPLE_PATCH },
          { path: "src/b.ts", patch: null },
        ]}
      />,
    );
    expect(screen.getByText("2 files changed")).toBeInTheDocument();
    // The path is split into a dimmed directory + emphasized basename, so the
    // full path lives in the element's `title` (and textContent), not a single
    // text node — assert via the title the header exposes for the full path.
    expect(screen.getByTitle("src/a.ts")).toBeInTheDocument();
    expect(screen.getByTitle("src/b.ts")).toBeInTheDocument();
    expect(screen.getByTitle("src/a.ts")).toHaveTextContent("src/a.ts");
  });

  it("splits the path into a dimmed directory and emphasized basename", () => {
    render(
      <CodeDiffCard
        files={[{ path: "src/deep/file.ts", patch: SAMPLE_PATCH }]}
      />,
    );
    const pathEl = screen.getByTitle("src/deep/file.ts");
    // Directory prefix and basename are separate spans for the dim/emphasis
    // treatment; together they reconstruct the full path.
    expect(pathEl).toHaveTextContent("src/deep/file.ts");
    expect(within(pathEl).getByText("file.ts")).toHaveClass("font-medium");
  });

  it("shows computed additions/deletions totals when patches are present", () => {
    render(
      <CodeDiffCard files={[{ path: "src/a.ts", patch: SAMPLE_PATCH }]} />,
    );
    // With a single file, the header aggregate and the per-file row show the
    // same totals — scope to the file's own row to avoid an ambiguous match.
    const fileRow = within(document.getElementById("diff-src%2Fa.ts")!);
    expect(fileRow.getByText("+2")).toBeInTheDocument();
    expect(fileRow.getByText("-1")).toBeInTheDocument();
  });

  it("prefers explicit additions/deletions over computed values", () => {
    render(
      <CodeDiffCard
        files={[
          {
            path: "src/a.ts",
            patch: SAMPLE_PATCH,
            additions: 40,
            deletions: 5,
          },
        ]}
      />,
    );
    const fileRow = within(document.getElementById("diff-src%2Fa.ts")!);
    expect(fileRow.getByText("+40")).toBeInTheDocument();
    expect(fileRow.getByText("-5")).toBeInTheDocument();
  });

  it("shows a fallback message when a file has no patch content", () => {
    render(<CodeDiffCard files={[{ path: "src/no-patch.ts" }]} />);
    expect(
      screen.getByText(
        "No diff content available for this file in this result.",
      ),
    ).toBeInTheDocument();
  });

  it("renders the summary text when provided", () => {
    render(
      <CodeDiffCard
        files={[{ path: "a.ts", patch: SAMPLE_PATCH }]}
        summary="Fixed the bug"
      />,
    );
    expect(screen.getByText("Fixed the bug")).toBeInTheDocument();
  });

  it("renders an external link with the given label", () => {
    render(
      <CodeDiffCard
        files={[{ path: "a.ts", patch: SAMPLE_PATCH }]}
        externalUrl="https://github.com/acme/repo/pull/42"
        externalLabel="PR #42"
      />,
    );
    const link = screen.getByRole("link", { name: /PR #42/ });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/repo/pull/42",
    );
  });

  it("sets the file section id to the shared diff anchor id", () => {
    render(
      <CodeDiffCard files={[{ path: "src/a.ts", patch: SAMPLE_PATCH }]} />,
    );
    expect(
      document.getElementById(diffAnchorId("src/a.ts")),
    ).toBeInTheDocument();
  });

  it("opens the first file by default when there are multiple files", () => {
    render(
      <CodeDiffCard
        files={[
          { path: "a.ts", patch: SAMPLE_PATCH },
          { path: "b.ts", patch: SAMPLE_PATCH },
        ]}
      />,
    );
    const first = document.getElementById(
      diffAnchorId("a.ts"),
    ) as HTMLDetailsElement;
    const second = document.getElementById(
      diffAnchorId("b.ts"),
    ) as HTMLDetailsElement;
    expect(first.open).toBe(true);
    expect(second.open).toBe(false);
  });

  it("shows the hunk header inside the opened file section", () => {
    render(<CodeDiffCard files={[{ path: "a.ts", patch: SAMPLE_PATCH }]} />);
    const section = document.getElementById(
      diffAnchorId("a.ts"),
    ) as HTMLElement;
    expect(within(section).getByText("@@ -1,3 +1,4 @@")).toBeInTheDocument();
  });

  it("upgrades code lines to syntax-highlighted dual-theme tokens", async () => {
    render(
      <CodeDiffCard files={[{ path: "src/a.ts", patch: SAMPLE_PATCH }]} />,
    );
    const section = document.getElementById(
      diffAnchorId("src/a.ts"),
    ) as HTMLElement;
    // Highlighting resolves in an effect, so wait for the .diff-token spans.
    await waitFor(() => {
      expect(section.querySelectorAll(".diff-token").length).toBeGreaterThan(0);
    });
    const token = section.querySelector(".diff-token") as HTMLElement;
    // Light colour applied inline; dark colour carried as the --shiki-dark var
    // that diff-token.css swaps under `.dark`.
    expect(token.style.color).toBe("rgb(17, 17, 17)");
    expect(token.style.getPropertyValue("--shiki-dark")).toBe("#eee");
  });

  it("renders plain (uncoloured) lines for unknown languages, never .diff-token", async () => {
    render(
      <CodeDiffCard files={[{ path: "notes.txt", patch: SAMPLE_PATCH }]} />,
    );
    const section = document.getElementById(
      diffAnchorId("notes.txt"),
    ) as HTMLElement;
    // Give the effect a tick; plaintext short-circuits to no highlight.
    await waitFor(() => {
      expect(within(section).getByText("@@ -1,3 +1,4 @@")).toBeInTheDocument();
    });
    expect(section.querySelectorAll(".diff-token").length).toBe(0);
  });
});

describe("parseTokenStyle", () => {
  it("returns undefined for an absent style", () => {
    expect(parseTokenStyle(undefined)).toBeUndefined();
  });

  it("camelCases standard props and preserves custom --shiki-* properties", () => {
    expect(
      parseTokenStyle("color:#111;font-weight:bold;--shiki-dark:#eee"),
    ).toEqual({
      color: "#111",
      fontWeight: "bold",
      "--shiki-dark": "#eee",
    });
  });

  it("ignores malformed declarations", () => {
    expect(parseTokenStyle("color:#111;;garbage;:novalue;key:")).toEqual({
      color: "#111",
    });
  });
});

describe("splitPath", () => {
  it("splits a nested path into a trailing-slash directory and basename", () => {
    expect(splitPath("src/deep/file.ts")).toEqual({
      dir: "src/deep/",
      base: "file.ts",
    });
  });

  it("returns an empty directory for a bare filename", () => {
    expect(splitPath("README.md")).toEqual({ dir: "", base: "README.md" });
  });
});

describe("classifyChange", () => {
  it("returns 'modified' for an absent patch", () => {
    expect(classifyChange(null)).toBe("modified");
    expect(classifyChange(undefined)).toBe("modified");
  });

  it("detects an added file from a new-file header or /dev/null source", () => {
    expect(classifyChange("new file mode 100644\n@@ -0,0 +1 @@\n+x")).toBe(
      "added",
    );
    expect(classifyChange("--- /dev/null\n+++ b/x.ts\n@@ -0,0 +1 @@\n+x")).toBe(
      "added",
    );
  });

  it("detects a deleted file from a deleted-file header or /dev/null target", () => {
    expect(classifyChange("deleted file mode 100644\n@@ -1 +0,0 @@\n-x")).toBe(
      "deleted",
    );
    expect(classifyChange("--- a/x.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x")).toBe(
      "deleted",
    );
  });

  it("returns 'modified' for an ordinary edit", () => {
    expect(classifyChange(SAMPLE_PATCH)).toBe("modified");
  });
});

describe("CodeDiffCard — change affordances & long-diff collapse", () => {
  const NEW_FILE_PATCH = [
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+export const a = 1;",
    "+export const b = 2;",
  ].join("\n");

  const DELETED_FILE_PATCH = [
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-export const gone = true;",
  ].join("\n");

  it("shows a New badge for an added file", () => {
    render(
      <CodeDiffCard files={[{ path: "src/new.ts", patch: NEW_FILE_PATCH }]} />,
    );
    const section = document.getElementById(diffAnchorId("src/new.ts"))!;
    expect(within(section).getByText("New")).toBeInTheDocument();
    expect(section.getAttribute("data-change-kind")).toBe("added");
  });

  it("shows a Deleted badge for a removed file", () => {
    render(
      <CodeDiffCard
        files={[{ path: "src/gone.ts", patch: DELETED_FILE_PATCH }]}
      />,
    );
    const section = document.getElementById(diffAnchorId("src/gone.ts"))!;
    expect(within(section).getByText("Deleted")).toBeInTheDocument();
    expect(section.getAttribute("data-change-kind")).toBe("deleted");
  });

  it("exposes a copy-path button alongside the copy-diff button", () => {
    render(
      <CodeDiffCard files={[{ path: "src/a.ts", patch: SAMPLE_PATCH }]} />,
    );
    expect(
      screen.getByRole("button", { name: "Copy path src/a.ts" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy diff for src/a.ts" }),
    ).toBeInTheDocument();
  });

  it("collapses a long file's tail behind a 'Show N more lines' expander", async () => {
    // 40 added code lines, over the 32-line threshold → first 20 shown, tail hidden.
    const bigPatch = [
      "@@ -0,0 +1,40 @@",
      ...Array.from({ length: 40 }, (_, i) => `+const v${i} = ${i};`),
    ].join("\n");
    render(<CodeDiffCard files={[{ path: "src/big.ts", patch: bigPatch }]} />);
    const section = document.getElementById(diffAnchorId("src/big.ts"))!;

    // Only the first 20 line-rows are present before expanding.
    expect(section.querySelectorAll("[data-line-type]")).toHaveLength(20);
    const more = screen.getByRole("button", { name: /Show 20 more lines/ });

    fireEvent.click(more);

    // After expanding, the full 40 line-rows render.
    await waitFor(() => {
      expect(section.querySelectorAll("[data-line-type]")).toHaveLength(40);
    });
    expect(
      screen.getByRole("button", { name: /Show fewer lines/ }),
    ).toBeInTheDocument();
  });

  it("does not collapse a short file (no expander button)", () => {
    render(
      <CodeDiffCard files={[{ path: "src/a.ts", patch: SAMPLE_PATCH }]} />,
    );
    expect(
      screen.queryByRole("button", { name: /Show .* more lines/ }),
    ).not.toBeInTheDocument();
  });
});
