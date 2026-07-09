"use client";

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { ChevronRight, File, Folder, GitCompare, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { diffAnchorId } from "./diff-anchor";

/**
 * file-tree-card — collapsible directory tree for coding-agent workspace or
 * repository listings (e.g. `agent.sandbox_file.list`). Entries with
 * `changed: true` link to their corresponding section in a `code-diff-card`
 * rendered earlier in the same turn, via the shared `diffAnchorId` anchor
 * convention (both cards may appear in the same scroll container).
 *
 * Interactive mode (all optional, purely additive):
 * - `onFileSelect` makes file rows tappable (opens the panel's file viewer).
 * - `onDirExpand` fires when a directory opens, letting the owning panel
 *   lazily fetch deeper listings; `loadingDirs` shows a spinner on dirs with
 *   an in-flight fetch.
 * - `actions` renders a right-aligned header slot (sandbox status strip).
 *
 * Mobile: rows are ≥44px touch targets below `md`, indentation is compact
 * (0.75rem/level) and long names truncate in the middle so deep paths fit
 * narrow screens.
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
  /** Right-aligned header slot (e.g. the sandbox status strip). */
  actions?: ReactNode;
  /** Makes file rows tappable; receives the entry's full relative path. */
  onFileSelect?: (path: string) => void;
  /** Fires when a directory row opens (for lazy deeper-listing fetches). */
  onDirExpand?: (path: string) => void;
  /** Directories with an in-flight lazy fetch — shown with a spinner. */
  loadingDirs?: ReadonlySet<string>;
}

interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  sizeBytes: number | null;
  changed: boolean;
  children: TreeNode[];
}

/** Interaction context threaded through the recursive rows. */
interface TreeInteractions {
  onFileSelect?: (path: string) => void;
  onDirExpand?: (path: string) => void;
  loadingDirs?: ReadonlySet<string>;
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

/**
 * Truncate the MIDDLE of a long file/dir name so both the meaningful prefix
 * and the extension survive on narrow screens ("very-long-component-name.tsx"
 * → "very-long-co…name.tsx"). Full path stays available via `title`.
 */
export function truncateMiddle(name: string, max = 28): string {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

// Compact indentation so deep paths fit phone-width screens; ≥44px touch
// targets below `md` (Tailwind min-h-11 = 2.75rem = 44px).
const ROW_CLASS =
  "flex w-full min-h-11 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm md:min-h-0";
const indent = (depth: number, extra = 0.375): { paddingLeft: string } => ({
  paddingLeft: `${depth * 0.75 + extra}rem`,
});

function DirRow({
  node,
  depth,
  interactions,
}: {
  node: TreeNode;
  depth: number;
  interactions: TreeInteractions;
}) {
  const [open, setOpen] = useState(depth < 1);
  const { onDirExpand, loadingDirs } = interactions;

  // Notify the owning panel whenever this directory is (or becomes) open so
  // it can lazily fetch children beyond the already-listed depth. The panel
  // dedupes via its loaded/in-flight sets, so refires are cheap no-ops.
  useEffect(() => {
    if (open) onDirExpand?.(node.path);
  }, [open, node.path, onDirExpand]);

  const loading = loadingDirs?.has(node.path) === true;

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          ROW_CLASS,
          "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        style={indent(depth)}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        <Folder className="size-4 shrink-0 text-info" aria-hidden="true" />
        <span className="truncate" title={node.path}>
          {truncateMiddle(node.name)}
        </span>
        {loading ? (
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
            aria-label={`Loading ${node.path}`}
          />
        ) : null}
      </button>
      {open ? (
        <ul>
          {node.children.map((child) => (
            <TreeRow key={child.path} node={child} depth={depth + 1} interactions={interactions} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function FileRow({
  node,
  depth,
  interactions,
}: {
  node: TreeNode;
  depth: number;
  interactions: TreeInteractions;
}) {
  const size = formatBytes(node.sizeBytes);
  const { onFileSelect } = interactions;

  const name = (
    <>
      <File className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" title={node.path}>
        {truncateMiddle(node.name)}
      </span>
    </>
  );

  return (
    <li
      className={cn(ROW_CLASS, onFileSelect && "px-0 py-0")}
      style={onFileSelect ? undefined : indent(depth, 1.6)}
      data-changed={node.changed || undefined}
    >
      {onFileSelect ? (
        <button
          type="button"
          onClick={() => onFileSelect(node.path)}
          aria-label={`View ${node.path}`}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0"
          style={indent(depth, 1.6)}
        >
          {name}
        </button>
      ) : (
        name
      )}
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

function TreeRow({
  node,
  depth,
  interactions,
}: {
  node: TreeNode;
  depth: number;
  interactions: TreeInteractions;
}) {
  return node.kind === "dir" ? (
    <DirRow node={node} depth={depth} interactions={interactions} />
  ) : (
    <FileRow node={node} depth={depth} interactions={interactions} />
  );
}

export default function FileTreeCard({
  entries,
  title,
  actions,
  onFileSelect,
  onDirExpand,
  loadingDirs,
}: FileTreeCardProps): ReactElement {
  const tree = buildFileTree(entries);
  const interactions: TreeInteractions = { onFileSelect, onDirExpand, loadingDirs };

  if (entries.length === 0 && !actions) {
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
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
        <span className="truncate text-sm font-semibold">{title ?? "Files"}</span>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {entries.length === 0 ? (
        <div className="px-4 py-3 text-sm text-muted-foreground">No files.</div>
      ) : (
        <div className="max-h-96 overflow-y-auto overflow-x-auto px-2 py-2">
          <ul>
            {tree.map((node) => (
              <TreeRow key={node.path} node={node} depth={0} interactions={interactions} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
