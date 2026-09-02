"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useCopyToClipboard } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
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
} from "./file-tree-card";

/**
 * workspace-context-panel — the code-mode "see the sandbox" surface: sandbox
 * status strip (session id, running chip, refresh), a lazily-expanding
 * workspace file tree (`agent.sandbox_file.list`), and a tap-to-open file
 * viewer (`agent.sandbox_file.read`).
 *
 * Both scoped `/api/v1/:org/:ws/agent/sandbox/{files,file}` Next paths have no
 * local route handler — they fall through the next.config `fallback` rewrite
 * to the Hono API, which enforces IAM itself, so this component makes no
 * server action / invoke() call of its own. Tree rendering is delegated to
 * `FileTreeCard`; this panel owns the fetch/merge/lazy-expand state.
 *
 * Lazy expansion: each list fetch is bounded (depth 2). Expanding a directory
 * deeper than what's been fetched triggers a new list fetch rooted at that
 * directory; results merge into one flat entry map keyed by path, so large
 * trees load incrementally instead of all at once.
 *
 * Mobile (<768px, matchMedia): the file viewer renders as a full-width bottom
 * sheet; desktop gets a right-side panel. The viewport check is a local
 * useSyncExternalStore matchMedia subscription so this registry component has
 * no cross-file hook dependency.
 *
 * componentId: "workspace-context-panel"
 */

export interface WorkspaceContextPanelProps {
  sessionId: string;
  orgSlug?: string;
  workspaceSlug?: string;
  path?: string;
  depth?: number;
  title?: string;
  /**
   * A monotonically-increasing nonce. Whenever it changes, the tree soft-reloads
   * (re-fetch without the skeleton flash) — the owning page bumps it after a
   * terminal command runs so a `mkdir`/`rm`/clone shows up immediately instead
   * of waiting for a manual refresh. Omit when there's no command surface.
   */
  refreshSignal?: number;
}

interface SandboxFilesListResponse {
  entries: FileTreeEntry[];
}

interface SandboxFileReadResponse {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  sizeBytes: number;
  truncated: boolean;
}

/** Depth of every list fetch — the server default, one screenful at a time. */
const LAZY_FETCH_DEPTH = 2;

const MOBILE_QUERY = "(max-width: 767px)";

/**
 * Local SSR-safe `matchMedia` subscription (no cross-file hook dependency).
 * Returns false during SSR/hydration and in environments without matchMedia
 * (e.g. jsdom), so tests and first paint get the desktop layout.
 */
function useIsMobileViewport(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return () => {};
    }
    const mql = window.matchMedia(MOBILE_QUERY);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  const getSnapshot = useCallback(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return false;
    }
    return window.matchMedia(MOBILE_QUERY).matches;
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Directories whose direct children are fully known after a `depth`-bounded
 * fetch rooted at `base`: the base itself, every implied ancestor prefix, and
 * every listed dir strictly above the fetch's depth floor. Dirs AT the depth
 * boundary stay unloaded — expanding one triggers the next lazy fetch.
 */
export function computeLoadedDirs(
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
export function mergeEntries(
  existing: FileTreeEntry[],
  incoming: FileTreeEntry[],
): FileTreeEntry[] {
  const byPath = new Map(existing.map((e) => [e.path, e]));
  for (const entry of incoming) byPath.set(entry.path, entry);
  return [...byPath.values()];
}

/** Shorten an opaque session id for the status strip ("sbx_1a2b3c4d…"). */
export function shortSessionId(sessionId: string, max = 14): string {
  return sessionId.length <= max ? sessionId : `${sessionId.slice(0, max)}…`;
}

function CopyButton({
  value,
  label,
  className,
  children,
}: {
  value: string;
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => void copy(value)}
      className={cn(
        "inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0 md:min-w-0",
        className,
      )}
    >
      {children}
      {copied ? (
        <Check className="size-3.5 text-success" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

export default function WorkspaceContextPanel({
  sessionId,
  orgSlug = "",
  workspaceSlug = "",
  path,
  depth,
  title,
  refreshSignal,
}: WorkspaceContextPanelProps): ReactElement {
  const scopeBase =
    orgSlug !== "" && workspaceSlug !== "" && sessionId !== ""
      ? `/api/v1/${encodeURIComponent(orgSlug)}/${encodeURIComponent(workspaceSlug)}`
      : null;

  const isMobile = useIsMobileViewport();

  const [entries, setEntries] = useState<FileTreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Lazy-expansion bookkeeping. Refs (not state) so the `onDirExpand`
  // callback handed to FileTreeCard stays referentially stable across
  // fetches; `loadingDirs` is mirrored into state for the row spinners.
  const loadedDirsRef = useRef<Set<string>>(new Set());
  const loadingDirsRef = useRef<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<ReadonlySet<string>>(
    new Set(),
  );

  // File viewer state.
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [viewerData, setViewerData] = useState<SandboxFileReadResponse | null>(
    null,
  );
  const [viewerError, setViewerError] = useState<string | null>(null);

  const initialDepth = depth ?? LAZY_FETCH_DEPTH;

  // ── Root listing ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!scopeBase) {
      // No org/workspace/session context to scope the request — surface it
      // rather than firing a slug-less request that would 404.
      setError("missing workspace context");
      return;
    }
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`${scopeBase}/agent/sandbox/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, path, depth }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as SandboxFilesListResponse;
        if (!cancelled) {
          loadedDirsRef.current = computeLoadedDirs(
            path ?? "",
            json.entries,
            initialDepth,
          );
          setEntries(json.entries);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load workspace files",
          );
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- path/depth/sessionId identify one sandbox listing and never change for a mounted card; the root listing re-runs only when the scope changes or the user refreshes
  }, [scopeBase, refreshKey]);

  // ── Lazy directory expansion ──────────────────────────────────────────────

  const handleDirExpand = useCallback(
    (dirPath: string) => {
      if (!scopeBase) return;
      if (
        loadedDirsRef.current.has(dirPath) ||
        loadingDirsRef.current.has(dirPath)
      )
        return;
      loadingDirsRef.current.add(dirPath);
      setLoadingDirs(new Set(loadingDirsRef.current));

      void (async () => {
        try {
          const res = await fetch(`${scopeBase}/agent/sandbox/files`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId,
              path: dirPath,
              depth: LAZY_FETCH_DEPTH,
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as SandboxFilesListResponse;
          for (const dir of computeLoadedDirs(
            dirPath,
            json.entries,
            LAZY_FETCH_DEPTH,
          )) {
            loadedDirsRef.current.add(dir);
          }
          setEntries((prev) => mergeEntries(prev ?? [], json.entries));
          setError(null);
        } catch (err) {
          // Keep the dir unloaded so a re-toggle retries, and surface the
          // failure inline rather than swallowing it.
          setError(
            err instanceof Error ? err.message : "Failed to load directory",
          );
        } finally {
          loadingDirsRef.current.delete(dirPath);
          setLoadingDirs(new Set(loadingDirsRef.current));
        }
      })();
    },
    [scopeBase, sessionId],
  );

  // ── File viewer fetch ─────────────────────────────────────────────────────

  useEffect(() => {
    if (viewerPath === null || !scopeBase) return;
    let cancelled = false;
    setViewerData(null);
    setViewerError(null);

    void (async () => {
      try {
        const res = await fetch(`${scopeBase}/agent/sandbox/file`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, path: viewerPath }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as SandboxFileReadResponse;
        if (!cancelled) setViewerData(json);
      } catch (err) {
        if (!cancelled) {
          setViewerError(
            err instanceof Error ? err.message : "Failed to read file",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewerPath, scopeBase, sessionId]);

  const handleRefresh = useCallback(() => {
    loadedDirsRef.current = new Set();
    loadingDirsRef.current = new Set();
    setLoadingDirs(new Set());
    setEntries(null);
    setError(null);
    setRefreshKey((k) => k + 1);
  }, []);

  // Soft refresh: re-fetch the root listing WITHOUT clearing to the skeleton, so
  // a post-command reload doesn't flash empty. Lazy-expansion bookkeeping is
  // reset (deep listings re-fetch on re-expand); the current tree stays visible
  // until the fresh entries replace it.
  const softRefresh = useCallback(() => {
    loadedDirsRef.current = new Set();
    loadingDirsRef.current = new Set();
    setLoadingDirs(new Set());
    setRefreshKey((k) => k + 1);
  }, []);

  // Drive the soft refresh off the parent's nonce. A ref guards the initial
  // render so mounting doesn't double-fetch; only genuine changes reload.
  const prevSignalRef = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === undefined || prevSignalRef.current === refreshSignal)
      return;
    prevSignalRef.current = refreshSignal;
    softRefresh();
  }, [refreshSignal, softRefresh]);

  // ── Loading skeleton ──────────────────────────────────────────────────────

  if (!entries && !error) {
    return (
      <div
        className="my-2 animate-pulse space-y-2 rounded-xl border border-border bg-card p-4"
        data-component="workspace-context-panel"
      >
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-5/6 rounded bg-muted" />
        <div className="h-3 w-2/3 rounded bg-muted" />
      </div>
    );
  }

  // ── Error (nothing loaded at all) ─────────────────────────────────────────

  if (error && !entries) {
    return (
      <div
        className="my-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3"
        data-component="workspace-context-panel"
      >
        <p className="text-sm text-destructive">
          Failed to load workspace files: {error}
        </p>
      </div>
    );
  }

  // ── Status strip (header actions) ─────────────────────────────────────────

  const statusStrip = (
    <>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground">
        <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
        Sandbox running
      </span>
      <CopyButton value={sessionId} label="Copy session id">
        <span
          className="hidden font-mono text-[11px] sm:inline"
          title={sessionId}
        >
          {shortSessionId(sessionId)}
        </span>
      </CopyButton>
      <button
        type="button"
        aria-label="Refresh files"
        onClick={handleRefresh}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0 md:min-w-0"
      >
        <RefreshCw className="size-3.5" aria-hidden="true" />
      </button>
    </>
  );

  // ── File viewer body ──────────────────────────────────────────────────────

  const viewerBody = (() => {
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
    <div data-component="workspace-context-panel">
      {error && entries ? (
        <p className="mb-1 text-xs text-destructive">
          Failed to load directory: {error}
        </p>
      ) : null}
      <FileTreeCard
        entries={entries ?? []}
        title={title ?? "Workspace files"}
        actions={statusStrip}
        onFileSelect={setViewerPath}
        onDirExpand={handleDirExpand}
        loadingDirs={loadingDirs}
      />
      <Sheet
        open={viewerPath !== null}
        onOpenChange={(open) => {
          if (!open) setViewerPath(null);
        }}
      >
        <SheetPopup
          side={isMobile ? "bottom" : "right"}
          className={
            isMobile
              ? "flex max-h-[85dvh] w-full flex-col gap-3 rounded-t-xl p-4"
              : "flex w-full flex-col gap-3 p-4 sm:max-w-xl"
          }
        >
          <SheetHeader className="pr-8">
            <SheetTitle
              className="truncate text-left font-mono text-sm"
              title={viewerPath ?? undefined}
            >
              {viewerPath ? truncateMiddle(viewerPath, 48) : ""}
            </SheetTitle>
            <SheetDescription className="flex items-center gap-2 text-left text-xs">
              {viewerData ? (
                <>
                  <span>{formatBytes(viewerData.sizeBytes)}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {viewerData.encoding === "base64" ? "binary" : "utf-8"}
                  </span>
                </>
              ) : (
                <span>Reading file…</span>
              )}
              {viewerData ? (
                <CopyButton
                  value={viewerData.content}
                  label="Copy file contents"
                >
                  <span className="text-[11px]">Copy</span>
                </CopyButton>
              ) : null}
            </SheetDescription>
          </SheetHeader>
          <SheetPanel className="min-h-0">{viewerBody}</SheetPanel>
        </SheetPopup>
      </Sheet>
    </div>
  );
}
