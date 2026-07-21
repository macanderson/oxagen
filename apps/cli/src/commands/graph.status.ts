/**
 * `oxagen graph status` — show the state of the local workspace-graph replica.
 *
 * Reports node/edge counts, the current sync cursor (high-watermark), when it
 * was last synced, and the local DuckDB path. If no pull has been run yet,
 * says so clearly.
 */
import { existsSync } from "node:fs";
import { getOrgId, getWorkspaceId } from "../lib/config.js";
import { createGraphStore } from "@oxagen/engram";
import { graphStorePath } from "./graph.pull.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphStatusOptions {
  json?: boolean;
  /**
   * @internal test seam: override the DuckDB path.
   * Pass `":memory:"` in tests.
   */
  _duckdbPath?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGraphStatus(
  opts: GraphStatusOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const org = getOrgId();
  const workspace = getWorkspaceId();

  if (!org || !workspace) {
    writer.writeErr(
      "Missing org or workspace. Run `oxagen config` or set OXAGEN_ORG_ID / OXAGEN_WORKSPACE_ID.",
    );
    process.exitCode = 1;
    return;
  }

  const duckdbPath = opts._duckdbPath ?? graphStorePath(workspace);
  const pathIsMemory = duckdbPath === ":memory:";

  // If the file hasn't been created yet, tell the user to run pull first.
  if (!pathIsMemory && !existsSync(duckdbPath)) {
    if (opts.json) {
      writer.write(
        JSON.stringify({
          pulled: false,
          path: duckdbPath,
          org,
          workspace,
        }),
      );
    } else {
      writer.write(
        `No local graph copy found.\n` +
          `Run \`oxagen graph pull\` to download the workspace graph.\n` +
          `Expected path: ${duckdbPath}`,
      );
    }
    return;
  }

  const store = createGraphStore({ duckdbPath });
  let stats: Awaited<ReturnType<typeof store.stats>>;
  try {
    stats = await store.stats(org, workspace);
  } finally {
    await store.close();
  }

  if (opts.json) {
    writer.write(
      JSON.stringify({
        pulled: true,
        nodeCount: stats.nodeCount,
        edgeCount: stats.edgeCount,
        cursor: stats.cursor,
        syncedAt: stats.syncedAt,
        path: duckdbPath,
        org,
        workspace,
      }),
    );
  } else {
    const syncedAtStr = stats.syncedAt
      ? new Date(stats.syncedAt).toISOString()
      : "(never)";
    writer.write(
      `Nodes:       ${stats.nodeCount}\n` +
        `Edges:       ${stats.edgeCount}\n` +
        `Cursor:      ${stats.cursor ?? "(none)"}\n` +
        `Last synced: ${syncedAtStr}\n` +
        `Org:         ${org}\n` +
        `Workspace:   ${workspace}\n` +
        `Path:        ${duckdbPath}`,
    );
  }
}
