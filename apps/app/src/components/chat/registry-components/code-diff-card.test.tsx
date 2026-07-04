// @vitest-environment jsdom
/**
 * code-diff-card.test.tsx
 *
 * Unit tests for the code-diff registry component:
 *   1. parseUnifiedDiff — pure hunk parser (add/del/context/meta line classification)
 *   2. Render smoke tests — file header, +/- badges, hunk lines, empty state
 *
 * Registration in CHAT_COMPONENTS is covered by chat-component-registry.test.ts
 * (mocking "react" here to check the registry would conflict with the real
 * React hooks these render tests exercise, since vi.mock("react", ...) is
 * hoisted for the whole module).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { parseUnifiedDiff } from "./code-diff-card";

afterEach(cleanup);

// ── parseUnifiedDiff ─────────────────────────────────────────────────────────

describe("parseUnifiedDiff", () => {
  it("returns an empty array for an empty patch", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("parses a single hunk with add/del/context lines", () => {
    const patch = [
      "@@ -1,3 +1,3 @@",
      " context line",
      "-removed line",
      "+added line",
      " trailing context",
    ].join("\n");
    const hunks = parseUnifiedDiff(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.header).toBe("@@ -1,3 +1,3 @@");
    expect(hunks[0]?.lines).toEqual([
      { type: "context", content: "context line" },
      { type: "del", content: "removed line" },
      { type: "add", content: "added line" },
      { type: "context", content: "trailing context" },
    ]);
  });

  it("parses multiple hunks in one patch", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "@@ -10,1 +10,1 @@",
      "-old2",
      "+new2",
    ].join("\n");
    const hunks = parseUnifiedDiff(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[1]?.header).toBe("@@ -10,1 +10,1 @@");
  });

  it("skips file-header lines (---/+++) that precede the first hunk", () => {
    const patch = ["--- a/file.ts", "+++ b/file.ts", "@@ -1,1 +1,1 @@", "-x", "+y"].join("\n");
    const hunks = parseUnifiedDiff(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines).toEqual([
      { type: "del", content: "x" },
      { type: "add", content: "y" },
    ]);
  });

  it("classifies a no-newline-at-end-of-file marker as meta", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-x", "+y", "\\ No newline at end of file"].join("\n");
    const hunks = parseUnifiedDiff(patch);
    expect(hunks[0]?.lines[2]).toEqual({
      type: "meta",
      content: "\\ No newline at end of file",
    });
  });

  it("treats a context line without a leading space as-is", () => {
    // Some patch generators omit the leading space on a truly empty context line.
    const patch = ["@@ -1,1 +1,1 @@", ""].join("\n");
    const hunks = parseUnifiedDiff(patch);
    expect(hunks[0]?.lines[0]).toEqual({ type: "context", content: "" });
  });
});

// ── Render smoke tests ────────────────────────────────────────────────────────

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <span data-testid="badge" data-variant={variant}>
      {children}
    </span>
  ),
}));

describe("CodeDiffCard", () => {
  it("shows the empty state when files is empty", async () => {
    const { default: CodeDiffCard } = await import("./code-diff-card");
    render(<CodeDiffCard files={[]} />);
    expect(screen.getByText("No file changes to display.")).toBeInTheDocument();
  });

  it("renders a file header with path and +/- badges", async () => {
    const { default: CodeDiffCard } = await import("./code-diff-card");
    render(
      <CodeDiffCard
        files={[
          {
            path: "src/index.ts",
            patch: "@@ -1,1 +1,2 @@\n-a\n+a\n+b",
            additions: 1,
            deletions: 1,
          },
        ]}
      />,
    );
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    expect(screen.getByText("1 file changed")).toBeInTheDocument();
  });

  it("pluralizes the summary for multiple files", async () => {
    const { default: CodeDiffCard } = await import("./code-diff-card");
    render(
      <CodeDiffCard
        files={[
          { path: "a.ts", patch: "", additions: 0, deletions: 0 },
          { path: "b.ts", patch: "", additions: 0, deletions: 0 },
        ]}
      />,
    );
    expect(screen.getByText("2 files changed")).toBeInTheDocument();
  });

  it("shows a placeholder when a file's patch has no hunks", async () => {
    const { default: CodeDiffCard } = await import("./code-diff-card");
    render(<CodeDiffCard files={[{ path: "a.ts", patch: "", additions: 0, deletions: 0 }]} />);
    expect(screen.getByText("No diff preview available for this file.")).toBeInTheDocument();
  });

  it("renders hunk header and diff line content when a patch is present", async () => {
    const { default: CodeDiffCard } = await import("./code-diff-card");
    render(
      <CodeDiffCard
        files={[
          {
            path: "a.ts",
            patch: "@@ -1,1 +1,1 @@\n-old line\n+new line",
            additions: 1,
            deletions: 1,
          },
        ]}
      />,
    );
    expect(screen.getByText("@@ -1,1 +1,1 @@")).toBeInTheDocument();
    expect(screen.getByText("old line")).toBeInTheDocument();
    expect(screen.getByText("new line")).toBeInTheDocument();
  });

  it("collapses and expands a file section via the toggle button", async () => {
    const { default: CodeDiffCard } = await import("./code-diff-card");
    render(
      <CodeDiffCard
        files={[{ path: "a.ts", patch: "@@ -1,1 +1,1 @@\n-x\n+y", additions: 1, deletions: 1 }]}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Collapse a.ts" });
    fireEvent.click(toggle);
    expect(screen.queryByText("@@ -1,1 +1,1 @@")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand a.ts" }));
    expect(screen.getByText("@@ -1,1 +1,1 @@")).toBeInTheDocument();
  });

  it("renders the 'Open file' affordance stub for each file", async () => {
    const { default: CodeDiffCard } = await import("./code-diff-card");
    render(<CodeDiffCard files={[{ path: "a.ts", patch: "", additions: 0, deletions: 0 }]} />);
    expect(screen.getByRole("button", { name: "Open a.ts" })).toBeInTheDocument();
  });

  it("renders data-component='code-diff-card' attribute", async () => {
    const { default: CodeDiffCard } = await import("./code-diff-card");
    render(<CodeDiffCard files={[]} />);
    expect(document.querySelector("[data-component='code-diff-card']")).toBeInTheDocument();
  });
});
