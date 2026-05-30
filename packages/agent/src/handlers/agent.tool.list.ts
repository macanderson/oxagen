import type { CapabilityContext } from "../types.js";
import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";

// Dynamic import keeps oxagen out of the static package graph; otherwise
// oxagen handler shims → @oxagen/agent → @oxagen/oxagen creates a cycle.
async function loadRegistry() {
  const mod = (await import("@oxagen/oxagen")) as unknown as {
    listCapabilities: () => Array<{
      name: string;
      description: string;
      domain: string;
      agent?: { riskLevel?: "low" | "medium" | "high"; category?: string; requiresApproval?: boolean };
      surfaces?: readonly ("api" | "mcp" | "agent")[];
    }>;
    getSurfaces: (c: { surfaces?: readonly ("api" | "mcp" | "agent")[] }) => readonly string[];
  };
  return mod;
}

export interface AgentToolListInput {
  includeExternal: boolean;
}

export interface AgentToolListOutput {
  tools: Array<{
    name: string;
    description: string;
    domain: string;
    category: string | null;
    riskLevel: "low" | "medium" | "high";
    requiresApproval: boolean;
    external: boolean;
  }>;
}

export async function agentToolListHandler(
  input: AgentToolListInput,
  ctx: CapabilityContext,
): Promise<AgentToolListOutput> {
  const { listCapabilities, getSurfaces } = await loadRegistry();
  const builtins = listCapabilities()
    .filter((c) => getSurfaces(c).includes("agent"))
    .map((c) => ({
      name: c.name,
      description: c.description,
      domain: c.domain,
      category: c.agent?.category ?? null,
      riskLevel: c.agent?.riskLevel ?? "low",
      requiresApproval: c.agent?.requiresApproval ?? false,
      external: false,
    }));

  if (!input.includeExternal) return { tools: builtins };

  // Single tenant-scoped query; no per-server tool fanout. The discoveredTools
  // jsonb column is the cached snapshot from the last health check.
  const servers = await db()
    .select({
      name: schema.mcpServers.name,
      discoveredTools: schema.mcpServers.discoveredTools,
    })
    .from(schema.mcpServers)
    .where(
      and(
        eq(schema.mcpServers.orgId, ctx.orgId),
        eq(schema.mcpServers.workspaceId, ctx.workspaceId),
      ),
    );

  const external = servers.flatMap((s) =>
    (Array.isArray(s.discoveredTools) ? (s.discoveredTools as string[]) : []).map((t) => ({
      name: `${s.name}.${t}`,
      description: `External MCP tool ${t} on ${s.name}`,
      domain: "external",
      category: "external",
      riskLevel: "medium" as const,
      requiresApproval: true,
      external: true,
    })),
  );

  return { tools: [...builtins, ...external] };
}
