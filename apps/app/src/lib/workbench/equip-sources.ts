/**
 * workbench/equip-sources.ts — server-only source lists for the Agent Builder's
 * Equip step.
 *
 * The Equip step's uniform agentTools picker draws from four pools: skills,
 * tools (capabilities — see ./tools.ts), subagents (other agents — see
 * listAgents in ./agents.ts), and installed MCP servers. This module supplies
 * the two pools that don't already have a Workbench wrapper: workspace skills and
 * installed MCP-server plugins.
 *
 * Both reads degrade to an empty list on failure so the builder always renders
 * — an equip source being momentarily unavailable must never blank the wizard.
 *
 * Server-only. Never import from a "use client" module.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "@oxagen/handlers/logger";
import { withTimeout } from "@/lib/with-timeout";
import type { WorkbenchCtx } from "./scope";
import { listAgentTools, type AgentToolRow } from "./tools";
import { listAgents } from "./agents";

/**
 * A single equip source must never block the builder from rendering. The catch
 * blocks below cover a source that *rejects*; the shared `withTimeout` covers a
 * source that *hangs* (never settles) — e.g. a cold, expensive capability
 * materialization. Either way the pool degrades to empty and the wizard still
 * opens. Tighter than the generic page-read budget: the builder has four of
 * these in flight and must open promptly.
 */
const SOURCE_TIMEOUT_MS = 8000;

// ── Skills ──────────────────────────────────────────────────────────────────

export type WorkspaceSkillRow = {
  /** Skill slug — the on-screen identifier, used as the agentTool `ref` for type "skill". */
  ref: string;
  name: string;
  description: string;
  enabled: boolean;
};

/**
 * List the skills installed in the workspace. Backed by skill.workspace.list;
 * its output slugs (NOT the public `id`, which is an internal storage key —
 * see the contract's own comment) are what we surface as the agentTool `ref`,
 * since that's what downstream resolution (chat-stream skill binding,
 * sandbox-template "agent_skill" tools) matches against.
 *
 * Note: skill.workspace.list's contract surfaces are ["api","mcp"] (no
 * "agent"), so we deliberately DO NOT pass an opts.surface — the kernel only
 * enforces the surface allowlist when opts.surface is set, and ctx.surface is
 * the transport-level "app". Passing { surface: "agent" } here would throw
 * surface_denied.
 */
export async function listWorkspaceSkills(
  ctx: WorkbenchCtx,
): Promise<WorkspaceSkillRow[]> {
  try {
    const out = (await invoke("list_workspace_skills", {}, ctx)) as {
      skills: Array<{
        id: string;
        slug: string;
        name: string;
        description: string;
        enabled: boolean;
      }>;
    };
    return out.skills.map((s) => ({
      ref: s.slug,
      name: s.name,
      description: s.description,
      enabled: s.enabled,
    }));
  } catch (err) {
    logger.error(
      { err, workspaceId: ctx.workspaceId },
      "equip-sources: skill.workspace.list failed — rendering empty skills pool",
    );
    return [];
  }
}

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

export type EquipSubagentRow = { ref: string; name: string; slug: string };

export type EquipSources = {
  skills: WorkspaceSkillRow[];
  tools: AgentToolRow[];
  subagents: EquipSubagentRow[];
  mcp: InstalledMcpServerRow[];
};

/**
 * Load all four Equip pools in parallel, each guarded by a timeout so a slow or
 * hanging source (e.g. cold capability materialization behind agent.tool.list)
 * can never block the Agent Builder from rendering. Used by the new and edit
 * builder pages so both stay resilient.
 */
export async function loadEquipSources(
  ctx: WorkbenchCtx,
  orgId: string,
  workspaceId: string,
): Promise<EquipSources> {
  const [skills, tools, agents, mcp] = await Promise.all([
    withTimeout(
      listWorkspaceSkills(ctx),
      [] as WorkspaceSkillRow[],
      "equip-sources:skills",
      SOURCE_TIMEOUT_MS,
    ),
    withTimeout(
      listAgentTools(ctx),
      [] as AgentToolRow[],
      "equip-sources:tools",
      SOURCE_TIMEOUT_MS,
    ),
    withTimeout(
      listAgents(ctx),
      [],
      "equip-sources:subagents",
      SOURCE_TIMEOUT_MS,
    ),
    withTimeout(
      listInstalledMcpServers(ctx, orgId, workspaceId),
      [] as InstalledMcpServerRow[],
      "equip-sources:mcp",
      SOURCE_TIMEOUT_MS,
    ),
  ]);
  return {
    skills,
    tools,
    subagents: agents.map((a) => ({
      ref: a.publicId,
      name: a.name,
      slug: a.slug,
    })),
    mcp,
  };
}
