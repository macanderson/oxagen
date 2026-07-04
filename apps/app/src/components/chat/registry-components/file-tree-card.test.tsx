// @vitest-environment jsdom
/**
 * file-tree-card.test.tsx
 *
 * Unit tests for the file-tree registry component:
 *   1. buildFileTree — pure flat-path-list → nested tree builder
 *   2. Render smoke tests — nested rows, sizes, changed badge, collapse/expand, empty state
 *
 * Registration in CHAT_COMPONENTS is covered by chat-component-registry.test.ts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { buildFileTree } from "./file-tree-card";

afterEach(cleanup);

// ── buildFileTree ────────────────────────────────────────────────────────────

describe("buildFileTree", () => {
  it("returns an empty array for an empty entry list", () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it("builds a single root file node", () => {
    const tree = buildFileTree([{ path: "README.md", kind: "file" }]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: "README.md", path: "README.md", kind: "file" });
  });

  it("creates an implicit directory node for a nested file with no explicit dir entry", () => {
    const tree = buildFileTree([{ path: "src/index.ts", kind: "file" }]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: "src", kind: "dir" });
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]).toMatchObject({ name: "index.ts", path: "src/index.ts", kind: "file" });
  });

  it("merges an explicit dir entry's metadata into an implicitly-created placeholder", () => {
    const tree = buildFileTree([
      { path: "src/index.ts", kind: "file" },
      { path: "src", kind: "dir", changed: true },
    ]);
    expect(tree[0]).toMatchObject({ name: "src", kind: "dir", changed: true });
  });

  it("builds multiple levels of nesting", () => {
    const tree = buildFileTree([{ path: "a/b/c.ts", kind: "file", sizeBytes: 100 }]);
    expect(tree[0]?.name).toBe("a");
    expect(tree[0]?.children[0]?.name).toBe("b");
    expect(tree[0]?.children[0]?.children[0]).toMatchObject({ name: "c.ts", sizeBytes: 100 });
  });

  it("sorts directories before files, then alphabetically", () => {
    const tree = buildFileTree([
      { path: "z.ts", kind: "file" },
      { path: "a.ts", kind: "file" },
      { path: "lib", kind: "dir" },
    ]);
    expect(tree.map((n) => n.name)).toEqual(["lib", "a.ts", "z.ts"]);
  });

  it("marks a changed entry on the resulting node", () => {
    const tree = buildFileTree([{ path: "a.ts", kind: "file", changed: true }]);
    expect(tree[0]?.changed).toBe(true);
  });

  it("keeps multiple root-level siblings distinct", () => {
    const tree = buildFileTree([
      { path: "pkg-a/index.ts", kind: "file" },
      { path: "pkg-b/index.ts", kind: "file" },
    ]);
    expect(tree).toHaveLength(2);
    expect(tree.map((n) => n.name)).toEqual(["pkg-a", "pkg-b"]);
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

describe("FileTreeCard", () => {
  it("shows the empty state when entries is empty", async () => {
    const { default: FileTreeCard } = await import("./file-tree-card");
    render(<FileTreeCard entries={[]} />);
    expect(screen.getByText("No files.")).toBeInTheDocument();
  });

  it("renders a flat file entry with its formatted size", async () => {
    const { default: FileTreeCard } = await import("./file-tree-card");
    render(<FileTreeCard entries={[{ path: "README.md", kind: "file", sizeBytes: 2048 }]} />);
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  it("renders a 'changed' badge for a changed entry", async () => {
    const { default: FileTreeCard } = await import("./file-tree-card");
    render(<FileTreeCard entries={[{ path: "a.ts", kind: "file", changed: true }]} />);
    expect(screen.getByText("changed")).toBeInTheDocument();
  });

  it("renders nested directories and files", async () => {
    const { default: FileTreeCard } = await import("./file-tree-card");
    render(<FileTreeCard entries={[{ path: "src/index.ts", kind: "file" }]} />);
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("index.ts")).toBeInTheDocument();
  });

  it("collapses and re-expands a directory via its toggle", async () => {
    const { default: FileTreeCard } = await import("./file-tree-card");
    render(<FileTreeCard entries={[{ path: "src/index.ts", kind: "file" }]} />);
    const toggle = screen.getByRole("button", { name: "Collapse src" });
    fireEvent.click(toggle);
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand src" }));
    expect(screen.getByText("index.ts")).toBeInTheDocument();
  });

  it("renders data-component='file-tree-card' attribute", async () => {
    const { default: FileTreeCard } = await import("./file-tree-card");
    render(<FileTreeCard entries={[]} />);
    expect(document.querySelector("[data-component='file-tree-card']")).toBeInTheDocument();
  });
});

describe("FileTree (named export)", () => {
  it("is exported for reuse outside the chat registry", async () => {
    const { FileTree } = await import("./file-tree-card");
    expect(typeof FileTree).toBe("function");
    render(<FileTree entries={[{ path: "a.ts", kind: "file" }]} />);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
  });
});
