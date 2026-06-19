import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import { recordServerChange } from "../runtime/mcp-snapshots";
import type {
  AgentMcpDeleteInput,
  AgentMcpDeleteOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.delete";

export type { AgentMcpDeleteInput, AgentMcpDeleteOutput };

export async function agentMcpDeleteHandler(
  input: AgentMcpDeleteInput,
  ctx: CapabilityContext,
): Promise<AgentMcpDeleteOutput> {
  // Soft-delete: set deleted_at + disable so tools stop registering
  // immediately, but the row (and its tool_snapshots) survive >= 365 days for
  // replay durability before the retention job purges the snapshots.
  const now = new Date();
  const updated = await withTenantDb((tx) =>
    tx
      .update(schema.mcpServers)
      .set({
        deletedAt: now,
        deletedByUserId: ctx.userId,
        enabled: false,
        updatedAt: now,
        updatedByUserId: ctx.userId,
      })
      .where(
        and(
          eq(schema.mcpServers.publicId, input.mcpServerId),
          eq(schema.mcpServers.orgId, ctx.orgId),
          eq(schema.mcpServers.workspaceId, ctx.workspaceId),
          isNull(schema.mcpServers.deletedAt),
        ),
      )
      .returning({ id: schema.mcpServers.id }),
  );

  if (updated.length === 0) {
    // Already deleted or not found — idempotent no-op.
    return { mcpServerId: input.mcpServerId, deleted: false };
  }

  await recordServerChange({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    serverId: updated[0]!.id,
    changeType: "delete",
    actorUserId: ctx.userId,
  });

  return { mcpServerId: input.mcpServerId, deleted: true };
}
