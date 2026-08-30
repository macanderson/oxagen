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

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FileTreeCard, {
  buildFileTree,
  formatBytes,
  truncateMiddle,
  type FileTreeEntry,
} from "./file-tree-card";
import { diffAnchorId } from "./diff-anchor";

afterEach(cleanup);

describe("buildFileTree", () => {
  it("nests files under synthesized intermediate directories", () => {
    const entries: FileTreeEntry[] = [
      { path: "src/components/button.tsx", kind: "file" },
    ];
    const tree = buildFileTree(entries);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: "src", kind: "dir" });
    expect(tree[0]?.children[0]).toMatchObject({
      name: "components",
      kind: "dir",
    });
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
    render(
      <FileTreeCard
        entries={[{ path: "a.ts", kind: "file" }]}
        title="Workspace"
      />,
    );
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
    render(
      <FileTreeCard
        entries={[{ path: "src/a.ts", kind: "file", changed: true }]}
      />,
    );
    const link = screen.getByRole("link", { name: `View diff for src/a.ts` });
    expect(link).toHaveAttribute("href", `#${diffAnchorId("src/a.ts")}`);
  });

  it("does not show a diff link for an unchanged file", () => {
    render(
      <FileTreeCard
        entries={[{ path: "src/a.ts", kind: "file", changed: false }]}
      />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders a formatted file size when sizeBytes is provided", () => {
    render(
      <FileTreeCard
        entries={[{ path: "a.ts", kind: "file", sizeBytes: 2048 }]}
      />,
    );
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  it("collapses a nested directory (depth >= 1) by default and expands on click", async () => {
    render(
      <FileTreeCard entries={[{ path: "src/nested/file.ts", kind: "file" }]} />,
    );
    // "src" (depth 0) is open by default, revealing "nested" (depth 1).
    expect(screen.getByText("nested")).toBeInTheDocument();
    // "nested" itself is collapsed by default. Children stay MOUNTED (the
    // 0fr→1fr grid-rows animation needs them in the DOM), so collapse state
    // is asserted via the dir row's aria-expanded, not DOM absence.
    const nestedRow = screen.getByRole("button", { name: /nested/ });
    expect(nestedRow).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(nestedRow);
    expect(nestedRow).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("file.ts")).toBeInTheDocument();
  });

  it("renders header actions when provided", () => {
    render(
      <FileTreeCard
        entries={[{ path: "a.ts", kind: "file" }]}
        actions={<span>strip-content</span>}
      />,
    );
    expect(screen.getByText("strip-content")).toBeInTheDocument();
  });

  it("keeps the header (and actions) visible when there are no entries", () => {
    render(<FileTreeCard entries={[]} actions={<span>strip-content</span>} />);
    expect(screen.getByText("strip-content")).toBeInTheDocument();
    expect(screen.getByText("No files.")).toBeInTheDocument();
  });

  it("makes file rows tappable and reports the full path via onFileSelect", async () => {
    const onFileSelect = vi.fn();
    render(
      <FileTreeCard
        entries={[{ path: "src/index.ts", kind: "file" }]}
        onFileSelect={onFileSelect}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "View src/index.ts" }),
    );
    expect(onFileSelect).toHaveBeenCalledWith("src/index.ts");
  });

  it("does not render file rows as buttons without onFileSelect", () => {
    render(<FileTreeCard entries={[{ path: "src/index.ts", kind: "file" }]} />);
    expect(
      screen.queryByRole("button", { name: "View src/index.ts" }),
    ).not.toBeInTheDocument();
  });

  it("fires onDirExpand for default-open directories on mount", async () => {
    const onDirExpand = vi.fn();
    render(
      <FileTreeCard
        entries={[{ path: "src/index.ts", kind: "file" }]}
        onDirExpand={onDirExpand}
      />,
    );
    await waitFor(() => expect(onDirExpand).toHaveBeenCalledWith("src"));
  });

  it("fires onDirExpand when a collapsed directory is opened", async () => {
    const onDirExpand = vi.fn();
    render(
      <FileTreeCard
        entries={[{ path: "src/nested/file.ts", kind: "file" }]}
        onDirExpand={onDirExpand}
      />,
    );
    await userEvent.click(screen.getByText("nested"));
    expect(onDirExpand).toHaveBeenCalledWith("src/nested");
  });

  it("shows a spinner on directories with an in-flight lazy fetch", () => {
    render(
      <FileTreeCard
        entries={[{ path: "src/index.ts", kind: "file" }]}
        loadingDirs={new Set(["src"])}
      />,
    );
    expect(screen.getByLabelText("Loading src")).toBeInTheDocument();
  });

  it("truncates long names in the middle, keeping the extension visible", () => {
    render(
      <FileTreeCard
        entries={[
          {
            path: "extremely-long-component-file-name-for-mobile.tsx",
            kind: "file",
          },
        ]}
      />,
    );
    // NameLabel renders with max=44 (wider than the 28 default) so mirror it.
    const truncated = truncateMiddle(
      "extremely-long-component-file-name-for-mobile.tsx",
      44,
    );
    expect(truncated).toContain("…");
    expect(truncated.endsWith(".tsx")).toBe(true);
    expect(screen.getByText(truncated)).toBeInTheDocument();
  });
});

describe("truncateMiddle", () => {
  it("returns short names unchanged", () => {
    expect(truncateMiddle("index.ts")).toBe("index.ts");
  });

  it("caps output at the requested max length", () => {
    const out = truncateMiddle("a".repeat(100), 20);
    expect(out.length).toBe(20);
    expect(out).toContain("…");
  });

  it("preserves both the start and the end of the name", () => {
    const out = truncateMiddle(
      "prefix-abcdefghijklmnopqrstuvwxyz-suffix.txt",
      24,
    );
    expect(out.startsWith("prefix-")).toBe(true);
    expect(out.endsWith(".txt")).toBe(true);
  });
});
