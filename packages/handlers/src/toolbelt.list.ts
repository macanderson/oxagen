// audit-exempt: read-only apart from the one-time All tools belt row it may create; it grants nothing, and the kernel capability.invoke_* audit covers access.
//
// toolbelt.list.ts — the workspace's toolbelts, All tools first, with each
// belt's tool, active tool, server and agent counts (ADR-192, #4369).
//
// The first toolbelt path to touch a workspace creates its All tools belt, so
// this read can insert that one row. `availableTools` is the count the
// register form reads to decide whether its toolbelt step has anything to
// offer.
import { schema, withTenantDb } from "@oxagen/database";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { toolbeltList } from "@oxagen/oxagen/contracts/toolbelt.list";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  beltToolStates,
  ensureAllToolsBelt,
  listToolbelts,
  readWorkspaceTools,
  serverKeyOf,
  toolbeltRefOf,
  toolbeltsById,
} from "./lib/toolbelts";

/** The most belts one read returns (`toolbeltList.output.items`). */
const TOOLBELTS_READ_LIMIT = 500;

export const toolbeltListHandler: CapabilityHandler<
  typeof toolbeltList
> = async (_input, ctx) => {
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  return withTenantDb(async (tx) => {
    const allTools = await ensureAllToolsBelt(tx, scope, ctx.userId ?? null);
    const belts = (await listToolbelts(tx, scope)).slice(
      0,
      TOOLBELTS_READ_LIMIT,
    );
    const { tools } = await readWorkspaceTools(tx, scope);

    const customIds = belts.filter((b) => b.kind === "custom").map((b) => b.id);
    const memberRows =
      customIds.length === 0
        ? []
        : await tx
            .select({
              toolbeltId: schema.toolbeltTools.toolbeltId,
              toolId: schema.toolbeltTools.toolId,
              active: schema.toolbeltTools.active,
            })
            .from(schema.toolbeltTools)
            .where(inArray(schema.toolbeltTools.toolbeltId, customIds));
    const membersByBelt = new Map<string, Map<string, boolean>>();
    for (const row of memberRows) {
      const members =
        membersByBelt.get(row.toolbeltId) ?? new Map<string, boolean>();
      members.set(row.toolId, row.active);
      membersByBelt.set(row.toolbeltId, members);
    }

    // Live agents per belt. An agent that names no belt carries All tools.
    const carriers = await tx
      .select({
        toolbeltId: schema.agents.toolbeltId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, scope.orgId),
          eq(schema.agents.workspaceId, scope.workspaceId),
          isNull(schema.agents.deletedAt),
          ne(schema.agents.status, "archived"),
        ),
      )
      .groupBy(schema.agents.toolbeltId);
    const agentsByBelt = new Map<string, number>();
    for (const row of carriers) {
      const key = row.toolbeltId ?? allTools.id;
      agentsByBelt.set(key, (agentsByBelt.get(key) ?? 0) + row.count);
    }

    const sources = await toolbeltsById(
      tx,
      scope,
      belts.flatMap((b) => (b.clonedFromId === null ? [] : [b.clonedFromId])),
    );

    return {
      items: belts.map((belt) => {
        const held = beltToolStates(
          belt,
          tools,
          membersByBelt.get(belt.id) ?? new Map<string, boolean>(),
        ).filter((s) => s.member && s.tool.available);
        const source =
          belt.clonedFromId === null
            ? undefined
            : sources.get(belt.clonedFromId);
        return {
          ...toolbeltRefOf(belt),
          description: belt.description,
          clonedFrom: source ? toolbeltRefOf(source) : null,
          tools: held.length,
          activeTools: held.filter((s) => s.active).length,
          servers: new Set(held.map((s) => serverKeyOf(s.tool))).size,
          agents: agentsByBelt.get(belt.id) ?? 0,
          updatedAt: belt.updatedAt.toISOString(),
        };
      }),
      availableTools: tools.filter((t) => t.available).length,
    };
  });
};
