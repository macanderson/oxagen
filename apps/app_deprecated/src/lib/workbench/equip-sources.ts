/**
 * workbench/equip-sources.ts — server-only source lists for the Agent Builder's
 * tool-allowlist step.
 *
 * Per ADR-043 an agent's allowlist draws from exactly two pools: capabilities
 * (see ./tools.ts) and registered MCP servers. Skills and subagent fan-out are
 * retired with the runtime. This module supplies the pool that doesn't already
 * have a Workbench wrapper: installed MCP-server plugins.
 *
 * Every read degrades to an empty list on failure so the builder always renders
 * — an allowlist source being momentarily unavailable must never blank the
 * wizard.
 *
 * Server-only. Never import from a "use client" module.
 */
import "@oxagen/handlers/register";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "@oxagen/handlers/logger";
import { withTimeout } from "@/lib/with-timeout";
import type { WorkbenchCtx } from "./scope";
import { listAgentTools, type AgentToolRow } from "./tools";

/**
 * A single equip source must never block the builder from rendering. The catch
 * blocks below cover a source that *rejects*; the shared `withTimeout` covers a
 * source that *hangs* (never settles) — e.g. a cold, expensive capability
 * materialization. Either way the pool degrades to empty and the wizard still
 * opens. Tighter than the generic page-read budget: the builder has both of
 * these in flight and must open promptly.
 */
const SOURCE_TIMEOUT_MS = 8000;

// ── Installed MCP servers ─────────────────────────────────────────────────────

export type InstalledMcpServerRow = {
  /** installed_plugins public id — the agentTool `ref` for type "mcp_server". */
  ref: string;
  name: string;
  title: string | null;
  description: string | null;
  enabled: boolean;
};

/**
 * List the workspace's installed MCP-server plugins (pluginType 'mcp_server' or
 * 'mcp_server_local'). Read directly from plugin.installed_plugins under a
 * tenant scope — mirrors the direct read in settings/plugins/page.tsx. The
 * server id (public id) becomes the agentTool `ref`.
 */
export async function listInstalledMcpServers(
  ctx: WorkbenchCtx,
  orgId: string,
  workspaceId: string,
): Promise<InstalledMcpServerRow[]> {
  try {
    const rows = await runInTenantScope({ orgId, workspaceId }, () =>
      withTenantDb((tx) =>
        tx
          .select({
            publicId: schema.pluginInstalledPlugins.publicId,
            name: schema.pluginInstalledPlugins.name,
            title: schema.pluginInstalledPlugins.title,
            description: schema.pluginInstalledPlugins.description,
            enabled: schema.pluginInstalledPlugins.enabled,
            pluginType: schema.pluginInstalledPlugins.pluginType,
          })
          .from(schema.pluginInstalledPlugins)
          .where(
            and(
              eq(schema.pluginInstalledPlugins.orgId, orgId),
              eq(schema.pluginInstalledPlugins.workspaceId, workspaceId),
              isNull(schema.pluginInstalledPlugins.deletedAt),
            ),
          )
          .orderBy(schema.pluginInstalledPlugins.name),
      ),
    );
    return rows
      .filter(
        (r) =>
          r.pluginType === "mcp_server" || r.pluginType === "mcp_server_local",
      )
      .map((r) => ({
        ref: r.publicId,
        name: r.name,
        title: r.title,
        description: r.description,
        enabled: r.enabled,
      }));
  } catch (err) {
    logger.error(
      { err, orgId, workspaceId },
      "equip-sources: installed MCP-server read failed — rendering empty MCP pool",
    );
    return [];
  }
}

// ── Combined, timeout-guarded loader ──────────────────────────────────────────

export type EquipSources = {
  tools: AgentToolRow[];
  mcp: InstalledMcpServerRow[];
};

/**
 * Load both allowlist pools in parallel, each guarded by a timeout so a slow or
 * hanging source (e.g. cold capability materialization behind agent.tool.list)
 * can never block the Agent Builder from rendering. Used by the new and edit
 * builder pages so both stay resilient.
 */
export async function loadEquipSources(
  ctx: WorkbenchCtx,
  orgId: string,
  workspaceId: string,
): Promise<EquipSources> {
  const [tools, mcp] = await Promise.all([
    withTimeout(
      listAgentTools(ctx),
      [] as AgentToolRow[],
      "equip-sources:tools",
      SOURCE_TIMEOUT_MS,
    ),
    withTimeout(
      listInstalledMcpServers(ctx, orgId, workspaceId),
      [] as InstalledMcpServerRow[],
      "equip-sources:mcp",
      SOURCE_TIMEOUT_MS,
    ),
  ]);
  return { tools, mcp };
}
