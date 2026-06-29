/**
 * `GraphSyncProvider` adapter — after each turn, records execution lineage into
 * the workspace knowledge graph by pushing a `graph.sync.push` (source="lineage")
 * envelope to the platform.
 *
 * `ensureGraph` is currently a no-op: building a full code-graph envelope from
 * local file paths requires running the code-graph builder which is expensive
 * mid-turn. The `oxagen graph push` command and the ingestion pipeline handle
 * code-graph sync; this adapter is responsible only for execution lineage.
 *
 * Both methods are fire-and-forget (the engine wraps them in
 * `void Promise.resolve(...).catch(...)`). Errors are swallowed so graph sync
 * never blocks or fails a coding turn. Debounced 1 s so a burst of touched
 * files generates a single push rather than one-per-file.
 */
import type { GraphSyncProvider } from "@oxagen/agent-engine";

export interface GraphSyncOptions {
  apiUrl: string;
  token: string;
  orgSlug: string;
  workspaceSlug: string;
  cwd: string;
}

interface PendingLineage {
  executionId: string;
  touchedFiles: string[];
}

export function createGraphSyncProvider(opts: GraphSyncOptions): GraphSyncProvider {
  let pendingLineage: PendingLineage[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    timer = null;
    const lineage = pendingLineage;
    pendingLineage = [];
    for (const entry of lineage) {
      void pushLineage(opts, entry).catch(() => {});
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 1000);
    // Don't keep the process alive just to flush graph sync (e.g. one-shot runs).
    timer.unref?.();
  }

  return {
    // Code-graph delta sync (ensuring SourceFile nodes) is handled by the
    // ingestion pipeline and `oxagen graph push` — skip here to avoid running
    // the full tree-sitter builder mid-turn.
    ensureGraph(_touchedFiles) {
      // intentional no-op
    },
    recordLineage({ executionId, touchedFiles }) {
      pendingLineage.push({ executionId, touchedFiles });
      schedule();
    },
  };
}

async function pushLineage(opts: GraphSyncOptions, entry: PendingLineage): Promise<void> {
  const { executionId, touchedFiles } = entry;
  const repo = opts.cwd.split("/").pop() ?? "local";

  // Minimal lineage envelope: one AgentTurn node + TOUCHED_FILE edges to
  // existing SourceFile nodes (created by the ingestion pipeline / graph push).
  const turnKey = `lineage:turn:${executionId}`;
  const nodes = [
    {
      key: turnKey,
      labels: ["AgentTurn"],
      displayName: `Turn ${executionId}`,
      properties: {
        executionId,
        source: "cli",
        cwd: opts.cwd,
        touchedCount: touchedFiles.length,
        recordedAt: new Date().toISOString(),
      },
      isSystem: true,
    },
  ];

  const edges = touchedFiles.map((f) => ({
    sourceKey: turnKey,
    targetKey: `code:${repo}:${f}`,
    type: "TOUCHED_FILE",
    properties: { source: "cli" },
  }));

  await fetch(
    `${opts.apiUrl}/v1/${opts.orgSlug}/${opts.workspaceSlug}/graph/sync/push`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify({
        source: "lineage",
        idempotencyKey: `lineage:cli:${executionId}`,
        nodes,
        edges,
      }),
    },
  );
}
