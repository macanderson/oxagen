import type { CapabilityHandler } from "@oxagen/oxagen";
import { toolDeclarationList } from "@oxagen/oxagen/contracts/tool.declaration.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, count, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const toolDeclarationListHandler: CapabilityHandler<
  typeof toolDeclarationList
> = async (input, ctx) => {
  const filters = and(
    eq(schema.tools.workspaceId, ctx.workspaceId),
    isNull(schema.tools.deletedAt),
    ...(input.source ? [eq(schema.tools.source, input.source)] : []),
  );

  const [countRow] = await withTenantDb((tx) =>
    tx.select({ total: count() }).from(schema.tools).where(filters),
  );
  const total = countRow?.total ?? 0;

  // LEFT JOIN the pinned active version so the list can show the declared
  // schema facts without an N+1 per-row lookup (same shape as
  // skill.workspace.list). The join is null when no version is pinned yet.
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.tools.publicId,
        slug: schema.tools.slug,
        name: schema.tools.name,
        description: schema.tools.description,
        source: schema.tools.source,
        enabled: schema.tools.enabled,
        updatedAt: schema.tools.updatedAt,
        readOnly: schema.toolVersions.readOnly,
        riskGrade: schema.toolVersions.riskGrade,
        policyGroup: schema.toolVersions.policyGroup,
        versionNumber: schema.toolVersions.versionNumber,
        checksum: schema.toolVersions.checksum,
      })
      .from(schema.tools)
      .leftJoin(
        schema.toolVersions,
        eq(schema.toolVersions.id, schema.tools.activeVersionId),
      )
      .where(filters)
      .orderBy(schema.tools.slug)
      .limit(input.limit ?? 50)
      .offset(input.offset ?? 0),
  );

  logger.info(
    {
      workspaceId: ctx.workspaceId,
      count: rows.length,
      total,
      source: input.source ?? null,
      surface: ctx.surface,
    },
    "tool.declaration.list: returned declarations",
  );

  return {
    tools: rows.map((r) => ({
      id: r.publicId,
      slug: r.slug,
      name: r.name,
      description: r.description ?? null,
      source: r.source,
      enabled: r.enabled,
      readOnly: r.readOnly ?? null,
      riskGrade: r.riskGrade ?? null,
      policyGroup: r.policyGroup ?? null,
      version: r.versionNumber ?? null,
      checksum: r.checksum ?? null,
      updatedAt: r.updatedAt.toISOString(),
    })),
    total,
  };
};
