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
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import CodeDiffCard, {
  countDiffStats,
  parseTokenStyle,
  parseUnifiedDiff,
} from "./code-diff-card";
import { diffAnchorId } from "./diff-anchor";

afterEach(cleanup);

// Deterministic, synchronous syntax-highlight stub: the real Shiki highlighter
// needs WASM and is exercised in diff-syntax.test.ts. Here we assert the card
// WIRES tokens into `.diff-token` spans carrying the dual-theme style.
vi.mock("./diff-syntax", () => ({
  inferLang: (path: string) => (path.endsWith(".ts") ? "typescript" : "plaintext"),
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
    const markers = hunks[0]?.lines.filter((l) => l.content.includes("No newline"));
    expect(markers).toHaveLength(0);
  });

  it("skips pre-hunk file headers (---/+++)", () => {
    const patch = ["--- a/foo.ts", "+++ b/foo.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n");
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
        files={[{ path: "src/a.ts", patch: SAMPLE_PATCH }, { path: "src/b.ts", patch: null }]}
      />,
    );
    expect(screen.getByText("2 files changed")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
  });

  it("shows computed additions/deletions totals when patches are present", () => {
    render(<CodeDiffCard files={[{ path: "src/a.ts", patch: SAMPLE_PATCH }]} />);
    // With a single file, the header aggregate and the per-file row show the
    // same totals — scope to the file's own row to avoid an ambiguous match.
    const fileRow = within(document.getElementById("diff-src%2Fa.ts")!);
    expect(fileRow.getByText("+2")).toBeInTheDocument();
    expect(fileRow.getByText("-1")).toBeInTheDocument();
  });

  it("prefers explicit additions/deletions over computed values", () => {
    render(
      <CodeDiffCard
        files={[{ path: "src/a.ts", patch: SAMPLE_PATCH, additions: 40, deletions: 5 }]}
      />,
    );
    const fileRow = within(document.getElementById("diff-src%2Fa.ts")!);
    expect(fileRow.getByText("+40")).toBeInTheDocument();
    expect(fileRow.getByText("-5")).toBeInTheDocument();
  });

  it("shows a fallback message when a file has no patch content", () => {
    render(<CodeDiffCard files={[{ path: "src/no-patch.ts" }]} />);
    expect(
      screen.getByText("No diff content available for this file in this result."),
    ).toBeInTheDocument();
  });

  it("renders the summary text when provided", () => {
    render(<CodeDiffCard files={[{ path: "a.ts", patch: SAMPLE_PATCH }]} summary="Fixed the bug" />);
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
    expect(link).toHaveAttribute("href", "https://github.com/acme/repo/pull/42");
  });

  it("sets the file section id to the shared diff anchor id", () => {
    render(<CodeDiffCard files={[{ path: "src/a.ts", patch: SAMPLE_PATCH }]} />);
    expect(document.getElementById(diffAnchorId("src/a.ts"))).toBeInTheDocument();
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
    const first = document.getElementById(diffAnchorId("a.ts")) as HTMLDetailsElement;
    const second = document.getElementById(diffAnchorId("b.ts")) as HTMLDetailsElement;
    expect(first.open).toBe(true);
    expect(second.open).toBe(false);
  });

  it("shows the hunk header inside the opened file section", () => {
    render(<CodeDiffCard files={[{ path: "a.ts", patch: SAMPLE_PATCH }]} />);
    const section = document.getElementById(diffAnchorId("a.ts")) as HTMLElement;
    expect(within(section).getByText("@@ -1,3 +1,4 @@")).toBeInTheDocument();
  });

  it("upgrades code lines to syntax-highlighted dual-theme tokens", async () => {
    render(<CodeDiffCard files={[{ path: "src/a.ts", patch: SAMPLE_PATCH }]} />);
    const section = document.getElementById(diffAnchorId("src/a.ts")) as HTMLElement;
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
    render(<CodeDiffCard files={[{ path: "notes.txt", patch: SAMPLE_PATCH }]} />);
    const section = document.getElementById(diffAnchorId("notes.txt")) as HTMLElement;
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
    expect(parseTokenStyle("color:#111;font-weight:bold;--shiki-dark:#eee")).toEqual({
      color: "#111",
      fontWeight: "bold",
      "--shiki-dark": "#eee",
    });
  });

  it("ignores malformed declarations", () => {
    expect(parseTokenStyle("color:#111;;garbage;:novalue;key:")).toEqual({ color: "#111" });
  });
});
