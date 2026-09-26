// audit-exempt: read-only — one toolbelt and the workspace's tools grouped by server; the kernel capability.invoke_* audit covers access.
//
// toolbelt.get.ts — one toolbelt with every workspace tool grouped by the
// server it came from (ADR-198, #4369). Field semantics are on the contract
// (packages/oxagen/src/contracts/toolbelt.get.ts).
import { schema, withTenantDb } from "@oxagen/database";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  toolbeltGet,
  type ToolbeltGroup,
} from "@oxagen/oxagen/contracts/toolbelt.get";
import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import {
  DECLARED_TOOLS_GROUP,
  beltToolStates,
  readBeltMembers,
  readWorkspaceTools,
  requireToolbelt,
  serverKeyOf,
  toolbeltRefOf,
  toolbeltsById,
  type BeltToolState,
} from "./lib/toolbelts";

/** The most agents one read names (`toolbeltGet.output.agents`). */
const AGENTS_READ_LIMIT = 500;

export const toolbeltGetHandler: CapabilityHandler<typeof toolbeltGet> = async (
  input,
  ctx,
) => {
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  return withTenantDb(async (tx) => {
    const belt = await requireToolbelt(tx, scope, input.toolbeltId);
    const { tools, servers } = await readWorkspaceTools(tx, scope);
    const members =
      belt.kind === "all_tools"
        ? new Map<string, boolean>()
        : await readBeltMembers(tx, belt.id);
    const states = beltToolStates(belt, tools, members);

    // One group per live server, in name order, after the declared tools when
    // the workspace has any. A server whose tools were never imported is a
    // group with no tools, so the editor can say there is nothing to add yet.
    const byServer = new Map<string, BeltToolState[]>();
    for (const state of states) {
      const key = serverKeyOf(state.tool);
      const list = byServer.get(key) ?? [];
      list.push(state);
      byServer.set(key, list);
    }
    const keys = [
      ...(byServer.has("") ? [""] : []),
      // readWorkspaceTools returns the servers in name order.
      ...servers.keys(),
    ];
    const groups: ToolbeltGroup[] = keys.map((key) => {
      const server = key === "" ? null : servers.get(key);
      const list = byServer.get(key) ?? [];
      return {
        server: {
          id: server?.publicId ?? null,
          name: server?.name ?? DECLARED_TOOLS_GROUP,
        },
        included:
          belt.kind === "all_tools"
            ? list.length > 0
            : list.some((state) => state.member),
        tools: list.map((state) => ({
          id: state.tool.publicId,
          slug: state.tool.slug,
          name: state.tool.name,
          description: state.tool.description,
          available: state.tool.available,
          defaultActive: state.tool.defaultActive,
          active: state.active,
          member: state.member,
        })),
      };
    });

    // The live agents carrying the belt; one naming no belt carries All tools.
    const carriers = await tx
      .select({
        publicId: schema.agents.publicId,
        name: schema.agents.name,
        slug: schema.agents.slug,
      })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, scope.orgId),
          eq(schema.agents.workspaceId, scope.workspaceId),
          isNull(schema.agents.deletedAt),
          ne(schema.agents.status, "archived"),
          belt.kind === "all_tools"
            ? or(
                eq(schema.agents.toolbeltId, belt.id),
                isNull(schema.agents.toolbeltId),
              )
            : eq(schema.agents.toolbeltId, belt.id),
        ),
      )
      .orderBy(asc(schema.agents.slug))
      .limit(AGENTS_READ_LIMIT);

    const source =
      belt.clonedFromId === null
        ? undefined
        : (await toolbeltsById(tx, scope, [belt.clonedFromId])).get(
            belt.clonedFromId,
          );
    return {
      toolbelt: {
        ...toolbeltRefOf(belt),
        description: belt.description,
        clonedFrom: source ? toolbeltRefOf(source) : null,
        updatedAt: belt.updatedAt.toISOString(),
      },
      groups,
      agents: carriers.map((a) => ({
        id: a.publicId,
        name: a.name,
        slug: a.slug,
      })),
    };
  });
};
