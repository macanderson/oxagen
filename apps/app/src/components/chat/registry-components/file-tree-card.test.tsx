// @vitest-environment jsdom
/**
 * file-tree-card.test.tsx
 *
 * Covers:
 *   - buildFileTree: nesting, synthesized intermediate directories, sort order
 *   - formatBytes: byte/KB/MB formatting
 *   - FileTreeCard render: empty state, nested tree, changed-file diff link,
 *     directory collapse/expand
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FileTreeCard, { buildFileTree, formatBytes, type FileTreeEntry } from "./file-tree-card";
import { diffAnchorId } from "./diff-anchor";

afterEach(cleanup);

describe("buildFileTree", () => {
  it("nests files under synthesized intermediate directories", () => {
    const entries: FileTreeEntry[] = [{ path: "src/components/button.tsx", kind: "file" }];
    const tree = buildFileTree(entries);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: "src", kind: "dir" });
    expect(tree[0]?.children[0]).toMatchObject({ name: "components", kind: "dir" });
    expect(tree[0]?.children[0]?.children[0]).toMatchObject({
      name: "button.tsx",
      kind: "file",
      path: "src/components/button.tsx",
    });
  });

  it("sorts directories before files, then alphabetically", () => {
    const entries: FileTreeEntry[] = [
      { path: "b.ts", kind: "file" },
      { path: "a.ts", kind: "file" },
      { path: "zdir/x.ts", kind: "file" },
    ];
    const tree = buildFileTree(entries);
    expect(tree.map((n) => n.name)).toEqual(["zdir", "a.ts", "b.ts"]);
  });

  it("attaches sizeBytes and changed to the matching leaf entry", () => {
    const entries: FileTreeEntry[] = [
      { path: "a.ts", kind: "file", sizeBytes: 512, changed: true },
    ];
    const tree = buildFileTree(entries);
    expect(tree[0]).toMatchObject({ sizeBytes: 512, changed: true });
  });

  it("ignores empty paths", () => {
    expect(buildFileTree([{ path: "", kind: "file" }])).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("returns null for null/undefined", () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(undefined)).toBeNull();
  });
  it("formats bytes under 1024 as B", () => {
    expect(formatBytes(500)).toBe("500 B");
  });
  it("formats kilobytes with one decimal", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });
  it("formats megabytes without decimals once >= 10 units", () => {
    expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
  });
});

describe("FileTreeCard", () => {
  it("renders the empty state when there are no entries", () => {
    render(<FileTreeCard entries={[]} />);
    expect(screen.getByText("No files.")).toBeInTheDocument();
  });

  it("renders the title, defaulting to 'Files'", () => {
    render(<FileTreeCard entries={[{ path: "a.ts", kind: "file" }]} />);
    expect(screen.getByText("Files")).toBeInTheDocument();
  });

  it("renders a custom title when provided", () => {
    render(<FileTreeCard entries={[{ path: "a.ts", kind: "file" }]} title="Workspace" />);
    expect(screen.getByText("Workspace")).toBeInTheDocument();
  });

  it("renders top-level files and expanded top-level directories", () => {
    render(
      <FileTreeCard
        entries={[
          { path: "README.md", kind: "file" },
          { path: "src/index.ts", kind: "file" },
        ]}
      />,
    );
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("index.ts")).toBeInTheDocument();
  });

  it("shows a diff link for a changed file pointing at the shared diff anchor", () => {
    render(<FileTreeCard entries={[{ path: "src/a.ts", kind: "file", changed: true }]} />);
    const link = screen.getByRole("link", { name: `View diff for src/a.ts` });
    expect(link).toHaveAttribute("href", `#${diffAnchorId("src/a.ts")}`);
  });

  it("does not show a diff link for an unchanged file", () => {
    render(<FileTreeCard entries={[{ path: "src/a.ts", kind: "file", changed: false }]} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders a formatted file size when sizeBytes is provided", () => {
    render(<FileTreeCard entries={[{ path: "a.ts", kind: "file", sizeBytes: 2048 }]} />);
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  it("collapses a nested directory (depth >= 1) by default and expands on click", async () => {
    render(<FileTreeCard entries={[{ path: "src/nested/file.ts", kind: "file" }]} />);
    // "src" (depth 0) is open by default, revealing "nested" (depth 1).
    expect(screen.getByText("nested")).toBeInTheDocument();
    // "nested" itself is collapsed by default — its child isn't shown yet.
    expect(screen.queryByText("file.ts")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("nested"));
    expect(screen.getByText("file.ts")).toBeInTheDocument();
  });
});
