/**
 * `oxagen graph lineage` — project the local CLI TurnTrace history into the
 * workspace knowledge graph as a lineage subgraph (ADR-018 slice 3, up-sync).
 *
 * ## What is pushed
 *
 * For each TurnTrace not yet synced, the command builds a content-addressed
 * envelope of nodes and edges (see `lineage-projection.ts`) and sends it via
 * the `graph.sync.push` capability (source: "lineage").
 *
 * Nodes:
 *   • `lineage:session:{projectKey}` → [:AgentSession]
 *   • `lineage:turn:{turnId}`        → [:AgentTurn]
 *   • `lineage:tool:{turnId}:{idx}`  → [:AgentToolCall]  (verbose turns only)
 *   • `lineage:model:{slug}`         → [:AIModel]
 *   • `code:{repo}:{path}`           → [:SourceFile]     (links to code subgraph)
 *
 * Edges:
 *   • (AgentSession) -[:HAS_TURN]->    (AgentTurn)
 *   • (AgentTurn)    -[:USED_MODEL]->  (AIModel)
 *   • (AgentTurn)    -[:TOUCHED_FILE]→ (SourceFile)
 *   • (AgentTurn)    -[:USED_TOOL]->   (AgentToolCall)
 *
 * ## Cursor model
 *
 * The `createdAt` epoch-ms of the most recently synced turn is stored in the
 * local DuckDB GraphStore (`lineage_sync_cursor` table).  On each run, only
 * traces with `createdAt > lastSyncedAt` are projected and pushed.  Re-pushing
 * is idempotent: the server MERGE-keyed on the content-addressed node keys.
 *
 * ## ClickHouse (raw events)
 *
 * Raw per-turn token/cost/timing events belong in ClickHouse per ADR-018.
 * There is no CLI-accessible contract today for emitting these events directly
 * (the platform path uses Inngest + @oxagen/ai, both server-side). This is a
 * documented follow-up; the Neo4j lineage graph carries the summary metrics on
 * the AgentTurn node as a stopgap.
 *
 * ## Storage boundary
 *
 * Lineage subgraph → Neo4j (is_system=true) via graph.sync.push.
 * Cursor → DuckDB (local, same file as the code-push cursor).
 *
 * Output discipline (ADR-023 §4): `--json` emits one single-line JSON value on
 * stdout (both the summary and the up-to-date `{ upToDate: true }` shapes are
 * preserved); pretty mode prints the human summary on stdout; the single
 * "Syncing N turn(s)…" status line is progress → stderr via `out.info`. Every
 * failure is a uniform stderr error line with exit code 1, and `store.close()`
 * always runs in `finally` — so the push uses `apiPostOrThrow` (which throws
 * into the surrounding catch) rather than `apiPost` (which hard-exits and would
 * skip `finally`).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { apiPostOrThrow } from "../lib/api.js";
import { getOrgId, getWorkspaceId } from "../lib/config.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { openTraceStore } from "../agent/trace-store.js";
import { projectTrace, mergeEnvelopes } from "../agent/lineage-projection.js";
import { createGraphStore } from "@oxagen/engram";
import { graphStorePath } from "./graph.pull.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphLineageOptions {
  /** Override the repo identifier (default: git remote origin URL or path hash). */
  repo?: string;
  /** Output summary as JSON. */
  json?: boolean;
  /** @internal test seam: override the DuckDB path. */
  _duckdbPath?: string;
  /** @internal test seam: override the trace store (replaces openTraceStore). */
  _traceStore?: ReturnType<typeof openTraceStore>;
  /** @internal test seam: override the git root. */
  _gitRoot?: string;
}

interface PushResult {
  nodesUpserted: number;
  edgesUpserted: number;
  tombstoned: number;
}

// ---------------------------------------------------------------------------
// Git helpers (repo identifier, mirroring graph.push.ts)
// ---------------------------------------------------------------------------

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function resolveGitRoot(cwd: string): string | null {
  try {
    return runGit(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    return null;
  }
}

function resolveRepoId(root: string): string {
  try {
    const url = runGit(["remote", "get-url", "origin"], root);
    if (url) return url;
  } catch {
    // no remote — fall back to path hash
  }
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGraphLineage(
  opts: GraphLineageOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const org = getOrgId();
  const workspace = getWorkspaceId();

  if (!org || !workspace) {
    out.error(
      "Missing org or workspace. Run `oxagen config` or set " +
        "OXAGEN_ORG_ID / OXAGEN_WORKSPACE_ID.",
      "config",
    );
    return;
  }

  // Resolve optional repo identifier for file-node cross-linking.
  const cwd = opts._gitRoot ?? process.cwd();
  const gitRoot = opts._gitRoot ?? resolveGitRoot(cwd);
  const repo = opts.repo ?? (gitRoot ? resolveRepoId(gitRoot) : undefined);

  // Open DuckDB store (lineage cursor lives here alongside code-push cursor).
  const duckdbPath = opts._duckdbPath ?? graphStorePath(workspace);
  if (duckdbPath !== ":memory:") {
    mkdirSync(dirname(duckdbPath), { recursive: true });
  }

  const store = createGraphStore({ duckdbPath });

  try {
    // Determine which traces to sync.
    const lastSyncedAt = await store.getLineageCursor(org, workspace);

    const traceStore = opts._traceStore ?? openTraceStore(cwd);
    const allTraces = traceStore.list();

    // Filter to only unsynchronised traces (createdAt > lastSyncedAt).
    const pendingTraces = lastSyncedAt
      ? allTraces.filter((t) => t.createdAt > lastSyncedAt)
      : allTraces;

    if (pendingTraces.length === 0) {
      const msg = lastSyncedAt
        ? `Lineage up to date — no new turns since ${new Date(lastSyncedAt).toISOString()}.`
        : "No turns found in the local trace store. Run at least one CLI query first.";
      // `--json` preserves the exact `{ upToDate: true }` shape as a single line.
      out.data({ upToDate: true }, () => msg);
      return;
    }

    // Project each pending trace into its lineage envelope and merge.
    const envelopes = pendingTraces.map((trace) =>
      projectTrace(trace, { repo }),
    );
    const merged = mergeEnvelopes(envelopes);

    // Build the idempotency key from the turn id range.
    const minCreatedAt = Math.min(...pendingTraces.map((t) => t.createdAt));
    const maxCreatedAt = Math.max(...pendingTraces.map((t) => t.createdAt));
    const idempotencyKey = `lineage:${org}:${workspace}:${minCreatedAt}:${maxCreatedAt}`;

    // Single status line → progress on stderr (no `\r`, so out.info is fine).
    out.info(
      `Syncing ${pendingTraces.length} turn(s): ` +
        `${merged.nodes.length} node(s), ${merged.edges.length} edge(s)...`,
    );

    // apiPostOrThrow (not apiPost): a push failure must throw into the catch
    // below so out.error reports it uniformly AND the finally closes the store.
    const result = await apiPostOrThrow<PushResult>("graph/sync/push", {
      source: "lineage",
      idempotencyKey,
      nodes: merged.nodes,
      edges: merged.edges,
    });

    // Advance the cursor to the latest synced turn.
    await store.setLineageCursor(org, workspace, maxCreatedAt);

    const summary = {
      nodesUpserted: result.nodesUpserted,
      edgesUpserted: result.edgesUpserted,
      tombstoned: result.tombstoned,
      turnsSynced: pendingTraces.length,
      lastSyncedAt: maxCreatedAt,
    };

    out.data(
      summary,
      () =>
        `Lineage synced to workspace graph:\n` +
        `  Turns synced:    ${pendingTraces.length}\n` +
        `  Nodes upserted:  ${result.nodesUpserted}\n` +
        `  Edges upserted:  ${result.edgesUpserted}\n` +
        `  Last turn at:    ${new Date(maxCreatedAt).toISOString()}`,
    );
  } catch (err) {
    out.error(err, "api");
    return;
  } finally {
    await store.close();
  }
}
