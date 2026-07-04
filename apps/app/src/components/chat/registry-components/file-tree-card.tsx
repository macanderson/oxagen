"use client";

import { useState, type ReactElement } from "react";
import { ChevronRight, File, Folder, GitCompare } from "lucide-react";
import { cn } from "@/lib/utils";
import { diffAnchorId } from "./diff-anchor";

/**
 * file-tree-card — collapsible directory tree for coding-agent workspace or
 * repository listings (e.g. `agent.sandbox.files.list`). Entries with
 * `changed: true` link to their corresponding section in a `code-diff-card`
 * rendered earlier in the same turn, via the shared `diffAnchorId` anchor
 * convention (both cards may appear in the same scroll container).
 *
 * componentId: "file-tree"
 */

export interface FileTreeEntry {
  /** Full path, relative to the tree root (e.g. "src/components/button.tsx"). */
  path: string;
  kind: "file" | "dir";
  sizeBytes?: number | null;
  /** True when this file has pending/committed changes in this turn. */
  changed?: boolean;
}

export interface FileTreeCardProps {
  entries: FileTreeEntry[];
  title?: string;
}

interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  sizeBytes: number | null;
  changed: boolean;
  children: TreeNode[];
}

/**
 * Builds a nested tree from a flat entry list. Intermediate directories that
 * are implied by a file's path but not present as their own "dir" entry are
 * synthesized (empty size, unchanged) so the tree is always fully connected.
 */
export function buildFileTree(entries: FileTreeEntry[]): TreeNode[] {
  const root = new Map<string, MutableNode>();

  interface MutableNode extends Omit<TreeNode, "children"> {
    children: Map<string, MutableNode>;
  }

  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

  for (const entry of sorted) {
    const parts = entry.path.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    let level = root;
    let currentPath = "";
    parts.forEach((part, idx) => {
      currentPath = currentPath.length > 0 ? `${currentPath}/${part}` : part;
      const isLast = idx === parts.length - 1;
      let node = level.get(part);
      if (!node) {
        node = {
          name: part,
          path: currentPath,
          kind: isLast ? entry.kind : "dir",
          sizeBytes: null,
          changed: false,
          children: new Map(),
        };
        level.set(part, node);
      }
      if (isLast) {
        node.kind = entry.kind;
        node.sizeBytes = entry.sizeBytes ?? null;
        node.changed = entry.changed ?? false;
      }
      level = node.children;
    });
  }

  const toArray = (map: Map<string, MutableNode>): TreeNode[] =>
    [...map.values()]
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((n) => ({ ...n, children: toArray(n.children) }));

  return toArray(root);
}

export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function DirRow({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ paddingLeft: `${depth * 1.1 + 0.375}rem` }}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        <Folder className="size-4 shrink-0 text-info" aria-hidden="true" />
        <span className="truncate">{node.name}</span>
      </button>
      {open ? (
        <ul>
          {node.children.map((child) => (
            <TreeRow key={child.path} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function FileRow({ node, depth }: { node: TreeNode; depth: number }) {
  const size = formatBytes(node.sizeBytes);
  return (
    <li
      className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm"
      style={{ paddingLeft: `${depth * 1.1 + 1.6}rem` }}
      data-changed={node.changed || undefined}
    >
      <File className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={node.path}>
        {node.name}
      </span>
      {size ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{size}</span> : null}
      {node.changed ? (
        <a
          href={`#${diffAnchorId(node.path)}`}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`View diff for ${node.path}`}
        >
          <GitCompare className="size-3" aria-hidden="true" />
          diff
        </a>
      ) : null}
    </li>
  );
}

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  return node.kind === "dir" ? <DirRow node={node} depth={depth} /> : <FileRow node={node} depth={depth} />;
}

export default function FileTreeCard({ entries, title }: FileTreeCardProps): ReactElement {
  const tree = buildFileTree(entries);

  if (entries.length === 0) {
    return (
      <div
        className="my-2 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
        data-component="file-tree-card"
      >
        No files.
      </div>
    );
  }

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="file-tree-card"
    >
      <div className="border-b border-border/60 px-4 py-2.5">
        <span className="text-sm font-semibold">{title ?? "Files"}</span>
      </div>
      <div className="max-h-96 overflow-y-auto overflow-x-auto px-2 py-2">
        <ul>
          {tree.map((node) => (
            <TreeRow key={node.path} node={node} depth={0} />
          ))}
        </ul>
      </div>
    </div>
  );
}
