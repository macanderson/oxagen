import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillWorkspaceList } from "@oxagen/oxagen/contracts/skill.workspace.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const skillWorkspaceListHandler: CapabilityHandler<typeof skillWorkspaceList> = async (
  _input,
  ctx,
) => {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.skills.publicId,
        name: schema.skills.name,
        description: schema.skills.description,
        enabled: schema.skills.enabled,
      })
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.workspaceId, ctx.workspaceId),
          isNull(schema.skills.deletedAt),
        ),
      ),
  );

  logger.info(
    { workspaceId: ctx.workspaceId, count: rows.length, surface: ctx.surface },
    "skill.workspace.list: returned skills",
  );

  return {
    skills: rows.map((r) => ({
      id: r.publicId,
      name: r.name,
      description: r.description ?? "",
      enabled: r.enabled,
    })),
  };
};
