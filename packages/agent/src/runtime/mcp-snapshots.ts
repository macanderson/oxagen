// mcp-snapshots.ts — external MCP tool-descriptor snapshots + server-change
// audit (OXA-820).
//
// At registration (and on re-enable) every discovered tool's JSONSchema
// descriptor is captured into mcp.tool_snapshots so replay of an old run can
// render the tool even after the server is disabled or deleted. Every
// enable/disable/delete lands an immutable audit row in
// security.mcp_server_changes.

import { withTenantDb, schema } from "@oxagen/database";
import { and, desc, eq } from "drizzle-orm";
import type { McpToolDescriptor } from "../dispatch/mcp-client";

export interface CaptureSnapshotArgs {
  orgId: string;
  workspaceId: string;
  mcpServerId: string;
  descriptors: McpToolDescriptor[];
  createdByUserId?: string | null;
}

/**
 * Write one snapshot row per discovered tool. Each call appends a new
 * captured_at version — older rows are preserved so a replayed run renders the
 * descriptor as it was when the run happened. Returns the number of rows written.
 */
export async function captureToolSnapshots(args: CaptureSnapshotArgs): Promise<number> {
  if (args.descriptors.length === 0) return 0;
  const values = args.descriptors.map((d) => ({
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    mcpServerId: args.mcpServerId,
    toolName: d.name,
    // Store the full descriptor (name + description + inputSchema) so a replay
    // can reconstruct the tool card without the server.
    schemaJson: {
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
    } as object,
    createdByUserId: args.createdByUserId ?? null,
  }));
  await withTenantDb((tx) => tx.insert(schema.mcpToolSnapshots).values(values));
  return values.length;
}

/**
 * Read the latest descriptor snapshot for each (server, tool) — the replay
 * lookup. Returns the most recent capture per tool name.
 */
export async function readLatestSnapshots(
  orgId: string,
  workspaceId: string,
  mcpServerId: string,
): Promise<Array<{ toolName: string; schemaJson: unknown; capturedAt: string }>> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        toolName: schema.mcpToolSnapshots.toolName,
        schemaJson: schema.mcpToolSnapshots.schemaJson,
        capturedAt: schema.mcpToolSnapshots.capturedAt,
      })
      .from(schema.mcpToolSnapshots)
      .where(
        and(
          eq(schema.mcpToolSnapshots.orgId, orgId),
          eq(schema.mcpToolSnapshots.workspaceId, workspaceId),
          eq(schema.mcpToolSnapshots.mcpServerId, mcpServerId),
        ),
      )
      .orderBy(desc(schema.mcpToolSnapshots.capturedAt)),
  );
  // Collapse to the newest row per tool name.
  const seen = new Set<string>();
  const out: Array<{ toolName: string; schemaJson: unknown; capturedAt: string }> = [];
  for (const r of rows) {
    if (seen.has(r.toolName)) continue;
    seen.add(r.toolName);
    out.push({
      toolName: r.toolName,
      schemaJson: r.schemaJson,
      capturedAt: r.capturedAt.toISOString(),
    });
  }
  return out;
}

export type McpServerChangeType = "enable" | "disable" | "delete";

export interface RecordServerChangeArgs {
  orgId: string;
  workspaceId: string;
  serverId: string;
  changeType: McpServerChangeType;
  actorUserId?: string | null;
}

/**
 * Append an immutable audit row to security.mcp_server_changes. Written on
 * every enable / disable / delete of an external MCP server.
 */
export async function recordServerChange(args: RecordServerChangeArgs): Promise<void> {
  await withTenantDb((tx) =>
    tx.insert(schema.mcpServerChanges).values({
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      serverId: args.serverId,
      changeType: args.changeType,
      actorUserId: args.actorUserId ?? null,
    }),
  );
}
