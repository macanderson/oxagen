"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, File as FileIcon, Folder } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatBytes } from "./file-attachment";

/**
 * file-tree-card — renders a flat list of workspace paths (e.g.
 * agent.sandbox.files.list output) as a collapsible directory tree instead of
 * a flat JSON array, marking entries touched by the current agent action.
 *
 * componentId: "file-tree"
 *
 * Also exports `FileTree` (named) so a later workspace-context panel can
 * reuse the tree rendering without going through the chat registry.
 */

export interface FileTreeEntry {
  path: string;
  kind: "file" | "dir";
  sizeBytes?: number;
  changed?: boolean;
}

export interface FileTreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  sizeBytes?: number;
  changed?: boolean;
  children: FileTreeNode[];
}

/**
 * Get (or lazily create) the directory node for `path`, wiring it into its
 * parent chain. Used both for explicit "dir" entries and for directories that
 * are only implied by a nested file path (e.g. a `src/index.ts` entry with no
 * standalone `src` entry in the flat list).
 */
function getOrCreateDir(
  map: Map<string, FileTreeNode>,
  roots: FileTreeNode[],
  path: string,
): FileTreeNode {
  const existing = map.get(path);
  if (existing) return existing;
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? path;
  const node: FileTreeNode = { name, path, kind: "dir", children: [] };
  map.set(path, node);
  const parentPath = segments.slice(0, -1).join("/");
  if (parentPath === "") {
    roots.push(node);
  } else {
    getOrCreateDir(map, roots, parentPath).children.push(node);
  }
  return node;
}

function sortTree(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const n of nodes) sortTree(n.children);
}

/**
 * Build a nested tree from a flat list of workspace-relative paths. Pure —
 * no React — so it's independently unit-testable.
 */
export function buildFileTree(entries: readonly FileTreeEntry[]): FileTreeNode[] {
  const map = new Map<string, FileTreeNode>();
  const roots: FileTreeNode[] = [];
  // Sort ascending so a parent directory is always visited no later than its
  // children — not required by the algorithm (getOrCreateDir recurses
  // upward regardless of order) but keeps result construction deterministic
  // across input orderings.
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

  for (const entry of sorted) {
    const segments = entry.path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    const name = segments[segments.length - 1] as string;
    const parentPath = segments.slice(0, -1).join("/");
    const parent = parentPath === "" ? null : getOrCreateDir(map, roots, parentPath);

    const existing = map.get(entry.path);
    if (existing) {
      // Already created as an implicit directory placeholder (a child path
      // was processed first) — merge the real entry data in.
      existing.kind = entry.kind;
      existing.sizeBytes = entry.sizeBytes;
      existing.changed = entry.changed;
      continue;
    }

    const node: FileTreeNode = {
      name,
      path: entry.path,
      kind: entry.kind,
      sizeBytes: entry.sizeBytes,
      changed: entry.changed,
      children: [],
    };
    map.set(entry.path, node);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  sortTree(roots);
  return roots;
}

function TreeRow({ node, depth }: { node: FileTreeNode; depth: number }) {
  const [open, setOpen] = React.useState(true);
  const isDir = node.kind === "dir";

  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-muted/60",
          node.changed && "bg-warning/10",
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        {isDir ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
            className="flex min-w-0 flex-1 items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {open ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <Folder className="size-3.5 shrink-0 text-info" aria-hidden="true" />
            <span className="truncate font-mono text-xs" title={node.path}>
              {node.name}
            </span>
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 pl-[18px]">
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate font-mono text-xs" title={node.path}>
              {node.name}
            </span>
          </span>
        )}
        {node.changed ? (
          <Badge variant="warning" className="shrink-0 text-[10px]">
            changed
          </Badge>
        ) : null}
        {!isDir && node.sizeBytes !== undefined ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatBytes(node.sizeBytes)}
          </span>
        ) : null}
      </div>
      {isDir && open && node.children.length > 0 ? (
        <ul>
          {node.children.map((child) => (
            <TreeRow key={child.path} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export interface FileTreeProps {
  entries: FileTreeEntry[];
}

/** Named export — reusable by a future workspace-context panel outside the chat registry. */
export function FileTree({ entries }: FileTreeProps): React.ReactElement {
  const roots = React.useMemo(() => buildFileTree(entries), [entries]);

  if (roots.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">No files.</p>;
  }

  return (
    <ul className="space-y-0.5" role="tree" aria-label="File tree">
      {roots.map((node) => (
        <TreeRow key={node.path} node={node} depth={0} />
      ))}
    </ul>
  );
}

export default function FileTreeCard({ entries }: FileTreeProps) {
  return (
    <div
      className="my-2 rounded-xl border bg-card p-3 text-sm text-card-foreground shadow"
      data-component="file-tree-card"
    >
      <FileTree entries={entries} />
    </div>
  );
}
