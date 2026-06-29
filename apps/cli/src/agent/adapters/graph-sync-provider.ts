/**
 * `GraphSyncProvider` adapter — after each turn, materialises the touched files
 * into the workspace knowledge graph and records execution lineage, by pushing a
 * git-native delta to the platform.
 *
 * Both methods are fire-and-forget (the engine wraps them in
 * `void Promise.resolve(...).catch(...)`). To avoid a request per file mid-turn,
 * touched files + lineage entries are debounced for 1s and flushed together;
 * every network call is best-effort and swallows its own errors so graph sync
 * never blocks or fails a coding turn.
 */
import type { GraphSyncProvider } from "@oxagen/agent-engine";

export interface GraphSyncOptions {
  apiUrl: string;
  token: string;
  orgSlug: string;
  workspaceSlug: string;
  cwd: string;
}

interface LineageEntry {
  executionId: string;
  touchedFiles: string[];
}

export function createGraphSyncProvider(opts: GraphSyncOptions): GraphSyncProvider {
  let pendingFiles: string[] = [];
  let pendingLineage: LineageEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    timer = null;
    const files = pendingFiles;
    const lineage = pendingLineage;
    pendingFiles = [];
    pendingLineage = [];
    if (files.length > 0) void pushDelta(opts, files).catch(() => {});
    for (const entry of lineage) void pushLineage(opts, entry).catch(() => {});
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 1000);
    // Don't keep the process alive just to flush graph sync (e.g. one-shot runs).
    timer.unref?.();
  }

  return {
    ensureGraph(touchedFiles) {
      pendingFiles = [...new Set([...pendingFiles, ...touchedFiles])];
      schedule();
    },
    recordLineage({ executionId, touchedFiles }) {
      pendingLineage.push({ executionId, touchedFiles });
      schedule();
    },
  };
}

async function pushDelta(opts: GraphSyncOptions, files: string[]): Promise<void> {
  await fetch(`${opts.apiUrl}/api/v1/graph/sync/push-delta`, {
    method: "POST",
    headers: headers(opts),
    body: JSON.stringify({ files, cwd: opts.cwd }),
  });
}

async function pushLineage(opts: GraphSyncOptions, entry: LineageEntry): Promise<void> {
  await fetch(`${opts.apiUrl}/api/v1/graph/lineage`, {
    method: "POST",
    headers: headers(opts),
    body: JSON.stringify(entry),
  });
}

function headers(opts: GraphSyncOptions): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.token}`,
    "x-org-slug": opts.orgSlug,
    "x-workspace-slug": opts.workspaceSlug,
  };
}
