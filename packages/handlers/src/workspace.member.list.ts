import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceMemberList } from "@oxagen/oxagen/contracts/workspace.member.list";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export const workspaceMemberListHandler: CapabilityHandler<
  typeof workspaceMemberList
> = async (_input, ctx) => {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.workspaceUsers.publicId,
        email: schema.users.email,
        role: schema.workspaceUsers.role,
        joinedAt: schema.workspaceUsers.joinedAt,
      })
      .from(schema.workspaceUsers)
      .innerJoin(
        schema.users,
        eq(schema.workspaceUsers.userId, schema.users.id),
      )
      .where(eq(schema.workspaceUsers.workspaceId, ctx.workspaceId)),
  );

  logger.info(
    { workspaceId: ctx.workspaceId, count: rows.length, surface: ctx.surface },
    "workspace.member.list: returned members",
  );

  return rows.map((r) => ({
    id: r.publicId,
    email: r.email,
    role: r.role,
    joined_at: r.joinedAt.toISOString(),
  }));
};
