"use client";

/**
 * sandbox-files-drawer.tsx — the right-side file browser for one durable
 * sandbox, opened from the detail-page header.
 *
 * Data comes from INJECTED loaders (`listFiles`/`readFile`) that the detail page
 * binds to the `list_sandbox_files`/`read_sandbox_file` server actions — a
 * direct capability invoke inside the app's own tenant scope. Do NOT route this
 * through a scoped `/api/v1/:org/:ws/agent/sandbox/…` fetch: that path only
 * reaches the Hono API via a next.config `fallback` rewrite, and the extra
 * cross-service hop is fragile under rewrite/auth/path drift. The loaders are
 * injected (like the terminal's `runCommand`) so this stays pure UI and is
 * unit-testable with mocks.
 *
 * The tree renderer (`FileTreeCard`) is the shared presentational component from
 * the chat registry, reused read-only. The lazy-expansion bookkeeping is a small
 * local copy so this drawer has no dependency on the chat panel itself.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FolderTree, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetPanel,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import FileTreeCard, {
  formatBytes,
  truncateMiddle,
  type FileTreeEntry,
} from "@/components/chat/registry-components/file-tree-card";
import { cn } from "@/lib/utils";
import type { SandboxStatus } from "@/lib/workbench/sandboxes";
import type {
  SandboxFileEntry,
  SandboxFileRead,
} from "@/app/[orgSlug]/[workspaceSlug]/workbench/sandboxes/[sessionId]/actions";

/** Injected list loader — bound to `list_sandbox_files` by the detail page. */
export type ListSandboxFilesFn = (opts: {
  path?: string;
  depth?: number;
}) => Promise<SandboxFileEntry[]>;

/** Injected read loader — bound to `read_sandbox_file` by the detail page. */
export type ReadSandboxFileFn = (path: string) => Promise<SandboxFileRead>;

export interface SandboxFilesDrawerProps {
  sessionId: string;
  /** Real session status — drives the header pill (never hard-coded). */
  status: SandboxStatus;
  listFiles: ListSandboxFilesFn;
  readFile: ReadSandboxFileFn;
  /**
   * Monotonic nonce; when it changes while the drawer is open the tree
   * soft-reloads (no skeleton flash) — the detail page bumps it after every
   * terminal command so a `mkdir`/`rm`/clone shows up immediately.
   */
  refreshSignal?: number;
  /** Disable browsing (viewer lacks manage rights). */
  disabled?: boolean;
}

/** Depth of every list fetch — one screenful at a time. */
const LAZY_FETCH_DEPTH = 2;

const STATUS_TONE: Record<SandboxStatus, string> = {
  running: "bg-success",
  idle: "bg-warning",
  stopped: "bg-muted-foreground",
  gone: "bg-muted-foreground",
};

/**
 * Directories whose direct children are fully known after a `depth`-bounded
 * fetch rooted at `base`. Local copy of the chat panel's algorithm so this
 * drawer stands alone.
 */
function computeLoadedDirs(
  base: string,
  entries: FileTreeEntry[],
  depth: number,
): Set<string> {
  const loaded = new Set<string>([base]);
  const baseSegs = base === "" ? 0 : base.split("/").length;
  for (const entry of entries) {
    const segs = entry.path.split("/");
    const last = entry.kind === "dir" ? segs.length : segs.length - 1;
    for (let i = baseSegs + 1; i <= last; i++) {
      if (i - baseSegs < depth) loaded.add(segs.slice(0, i).join("/"));
    }
  }
  return loaded;
}

/** Merge newly fetched entries into the flat list, deduped by path. */
function mergeEntries(
  existing: FileTreeEntry[],
  incoming: FileTreeEntry[],
): FileTreeEntry[] {
  const byPath = new Map(existing.map((e) => [e.path, e]));
  for (const entry of incoming) byPath.set(entry.path, entry);
  return [...byPath.values()];
}

function StatusPill({ status }: { status: SandboxStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium capitalize text-foreground">
      <span
        className={cn("size-1.5 rounded-full", STATUS_TONE[status])}
        aria-hidden="true"
      />
      {status}
    </span>
  );
}

export function SandboxFilesDrawer({
  sessionId,
  status,
  listFiles,
  readFile,
  refreshSignal,
  disabled = false,
}: SandboxFilesDrawerProps) {
  const [open, setOpen] = useState(false);

  const [entries, setEntries] = useState<FileTreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Lazy-expansion bookkeeping. Refs (not state) so the `onDirExpand` callback
  // handed to FileTreeCard stays referentially stable across fetches;
  // `loadingDirs` is mirrored into state for the row spinners.
  const loadedDirsRef = useRef<Set<string>>(new Set());
  const loadingDirsRef = useRef<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<ReadonlySet<string>>(
    new Set(),
  );

  // File viewer state.
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [viewerData, setViewerData] = useState<SandboxFileRead | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);

  // ── Root listing (only while open) ────────────────────────────────────────
  useEffect(() => {
    if (!open || disabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listFiles({ depth: LAZY_FETCH_DEPTH });
        if (cancelled) return;
        loadedDirsRef.current = computeLoadedDirs("", rows, LAZY_FETCH_DEPTH);
        setEntries(rows);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load files.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, disabled, refreshKey, listFiles]);

  // ── Lazy directory expansion ──────────────────────────────────────────────
  const handleDirExpand = useCallback(
    (dirPath: string) => {
      if (disabled) return;
      if (
        loadedDirsRef.current.has(dirPath) ||
        loadingDirsRef.current.has(dirPath)
      ) {
        return;
      }
      loadingDirsRef.current.add(dirPath);
      setLoadingDirs(new Set(loadingDirsRef.current));
      void (async () => {
        try {
          const rows = await listFiles({
            path: dirPath,
            depth: LAZY_FETCH_DEPTH,
          });
          for (const dir of computeLoadedDirs(
            dirPath,
            rows,
            LAZY_FETCH_DEPTH,
          )) {
            loadedDirsRef.current.add(dir);
          }
          setEntries((prev) => mergeEntries(prev ?? [], rows));
          setError(null);
        } catch (err) {
          // Keep the dir unloaded so a re-toggle retries; surface inline.
          setError(
            err instanceof Error ? err.message : "Failed to load directory.",
          );
        } finally {
          loadingDirsRef.current.delete(dirPath);
          setLoadingDirs(new Set(loadingDirsRef.current));
        }
      })();
    },
    [disabled, listFiles],
  );

  // ── File viewer fetch ─────────────────────────────────────────────────────
  useEffect(() => {
    if (viewerPath === null) return;
    let cancelled = false;
    setViewerData(null);
    setViewerError(null);
    void (async () => {
      try {
        const data = await readFile(viewerPath);
        if (!cancelled) setViewerData(data);
      } catch (err) {
        if (!cancelled) {
          setViewerError(
            err instanceof Error ? err.message : "Failed to read file.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewerPath, readFile]);

  // Hard refresh: clear to the skeleton and re-fetch the root.
  const handleRefresh = useCallback(() => {
    loadedDirsRef.current = new Set();
    loadingDirsRef.current = new Set();
    setLoadingDirs(new Set());
    setEntries(null);
    setError(null);
    setRefreshKey((k) => k + 1);
  }, []);

  // Soft refresh off the parent's nonce — re-fetch WITHOUT clearing to the
  // skeleton, so a post-command reload doesn't flash empty. Only fires while the
  // drawer is open; a closed drawer reloads fresh on next open anyway.
  const prevSignalRef = useRef(refreshSignal);
  useEffect(() => {
    if (
      refreshSignal === undefined ||
      prevSignalRef.current === refreshSignal
    ) {
      prevSignalRef.current = refreshSignal;
      return;
    }
    prevSignalRef.current = refreshSignal;
    if (!open) return;
    loadedDirsRef.current = new Set();
    loadingDirsRef.current = new Set();
    setLoadingDirs(new Set());
    setRefreshKey((k) => k + 1);
  }, [refreshSignal, open]);

  const viewerBody = (() => {
    if (viewerPath === null) {
      return (
        <p className="text-sm text-muted-foreground">
          Select a file to preview its contents.
        </p>
      );
    }
    if (viewerError) {
      return (
        <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Failed to read file: {viewerError}
        </p>
      );
    }
    if (!viewerData) {
      return (
        <div className="animate-pulse space-y-2" aria-label="Loading file">
          <div className="h-3 w-full rounded bg-muted" />
          <div className="h-3 w-5/6 rounded bg-muted" />
          <div className="h-3 w-2/3 rounded bg-muted" />
        </div>
      );
    }
    return (
      <>
        {viewerData.encoding === "base64" ? (
          <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            Binary file — showing its base64-encoded bytes.
          </p>
        ) : null}
        {viewerData.truncated ? (
          <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            File truncated — {formatBytes(viewerData.sizeBytes)} on disk;
            showing the first part.
          </p>
        ) : null}
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
          {viewerData.content}
        </pre>
      </>
    );
  })();

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="sandbox-files-open"
      >
        <FolderTree className="h-3.5 w-3.5" aria-hidden />
        Files
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup
          side="right"
          className="flex w-full flex-col gap-3 p-4 sm:max-w-2xl"
        >
          <SheetHeader className="pr-8">
            <SheetTitle className="text-left text-sm font-semibold">
              Sandbox files
            </SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-2 text-left">
              <StatusPill status={status} />
              <CopyableId value={sessionId} label="ID" max={16} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-7 gap-1 px-2 text-xs"
                onClick={handleRefresh}
                disabled={disabled}
                data-testid="sandbox-files-refresh"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Refresh
              </Button>
            </SheetDescription>
          </SheetHeader>

          <SheetPanel className="min-h-0 flex-row gap-0">
            {/* Tree column */}
            <div className="flex min-h-0 w-full shrink-0 flex-col overflow-y-auto border-border md:w-72 md:border-r md:pr-3">
              {disabled ? (
                <p className="px-1 py-3 text-sm text-muted-foreground">
                  Files are unavailable — you lack manage rights on this
                  workspace.
                </p>
              ) : error && !entries ? (
                <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  Failed to load files: {error}
                </p>
              ) : !entries ? (
                <div
                  className="animate-pulse space-y-2 px-1 py-2"
                  aria-label="Loading files"
                >
                  <div className="h-3 w-3/4 rounded bg-muted" />
                  <div className="h-3 w-full rounded bg-muted" />
                  <div className="h-3 w-5/6 rounded bg-muted" />
                  <div className="h-3 w-2/3 rounded bg-muted" />
                </div>
              ) : (
                <>
                  {error ? (
                    <p className="mb-1 px-1 text-xs text-destructive">
                      Failed to load directory: {error}
                    </p>
                  ) : null}
                  <FileTreeCard
                    entries={entries}
                    title="Files"
                    onFileSelect={setViewerPath}
                    onDirExpand={handleDirExpand}
                    loadingDirs={loadingDirs}
                  />
                </>
              )}
            </div>

            {/* Viewer column */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 md:pl-3">
              {viewerPath !== null ? (
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    <span
                      className="truncate font-mono text-sm text-foreground"
                      title={viewerPath}
                    >
                      {truncateMiddle(viewerPath, 48)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {viewerData
                        ? `${formatBytes(viewerData.sizeBytes) ?? "0 B"} · ${
                            viewerData.encoding === "base64"
                              ? "binary"
                              : "utf-8"
                          }`
                        : "Reading file…"}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    aria-label="Close file preview"
                    onClick={() => setViewerPath(null)}
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              ) : null}
              <div className="flex min-h-0 flex-1 flex-col">{viewerBody}</div>
            </div>
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    </>
  );
}

export default SandboxFilesDrawer;
