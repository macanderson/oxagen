import type { CapabilityHandler } from "@oxagen/oxagen";
import { toolDeclarationPublish } from "@oxagen/oxagen/contracts/tool.declaration.publish";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { canonicalJson, sha256Hex } from "./registry-digest";

/**
 * Publish one tool declaration into the workspace agent-asset registry.
 *
 * Upserts agent.tools by (workspace, slug) — slug is the lowercased name —
 * and creates a new immutable tool_versions row only when the canonical
 * manifest checksum changed; an unchanged declaration is idempotent
 * (published: false). Mirrors skill.workspace.install's shape: existence
 * check, transactional insert, and a unique-violation catch for the
 * concurrent-publish race.
 */
export const toolDeclarationPublishHandler: CapabilityHandler<
  typeof toolDeclarationPublish
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    throw new Error(
      "[tool.declaration.publish] workspaceId is required (scoped capability)",
    );
  }

  const slug = input.name.trim().toLowerCase();
  // The checksum covers every declared fact, not just the manifest body, so a
  // changed risk grade or schema republishes even when the manifest didn't.
  const checksum = sha256Hex(
    canonicalJson({
      description: input.description,
      input_schema: input.input_schema,
      manifest: input.manifest,
      name: slug,
      policy_group: input.policy_group ?? null,
      read_only: input.read_only,
      risk_grade: input.risk_grade,
      source: input.source,
    }),
  );

  const orgId = ctx.orgId;
  const workspaceId = ctx.workspaceId;

  const findExisting = async () => {
    const rows = await withTenantDb((tx) =>
      tx
        .select({
          id: schema.tools.id,
          publicId: schema.tools.publicId,
          slug: schema.tools.slug,
        })
        .from(schema.tools)
        .where(
          and(
            eq(schema.tools.orgId, orgId),
            eq(schema.tools.workspaceId, workspaceId),
            eq(schema.tools.slug, slug),
            isNull(schema.tools.deletedAt),
          ),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  };

  const versionValues = {
    orgId,
    workspaceId,
    inputSchema: input.input_schema,
    readOnly: input.read_only,
    riskGrade: input.risk_grade,
    policyGroup: input.policy_group ?? null,
    manifest: input.manifest,
    checksum,
    isLatest: true,
    publishedAt: sql`now()`,
    createdByUserId: ctx.userId ?? undefined,
    updatedByUserId: ctx.userId ?? undefined,
  };

  // Version-publish path against an existing identity row: idempotent when the
  // latest version already carries this checksum, otherwise latest+1.
  const publishVersionFor = async (existing: {
    id: string;
    publicId: string;
    slug: string;
  }) => {
    const [latest] = await withTenantDb((tx) =>
      tx
        .select({
          id: schema.toolVersions.id,
          versionNumber: schema.toolVersions.versionNumber,
          checksum: schema.toolVersions.checksum,
        })
        .from(schema.toolVersions)
        .where(
          and(
            eq(schema.toolVersions.toolId, existing.id),
            eq(schema.toolVersions.isLatest, true),
          ),
        )
        .limit(1),
    );

    if (latest && latest.checksum === checksum) {
      logger.info(
        { slug, publicId: existing.publicId, workspaceId },
        "tool.declaration.publish: idempotent — checksum unchanged",
      );
      return {
        publicId: existing.publicId,
        slug: existing.slug,
        version: latest.versionNumber,
        checksum,
        published: false,
      };
    }

    const nextVersion = (latest?.versionNumber ?? 0) + 1;
    await withTenantDb(async (tx) => {
      if (latest) {
        await tx
          .update(schema.toolVersions)
          .set({ isLatest: false, updatedAt: sql`now()` })
          .where(eq(schema.toolVersions.id, latest.id));
      }
      const [versionRow] = await tx
        .insert(schema.toolVersions)
        .values({
          ...versionValues,
          toolId: existing.id,
          versionNumber: nextVersion,
          parentVersionId: latest?.id ?? undefined,
        })
        .returning({ id: schema.toolVersions.id });
      if (!versionRow) {
        throw new Error(
          "[tool.declaration.publish] Version insert returned no row.",
        );
      }
      await tx
        .update(schema.tools)
        .set({
          name: input.name,
          description: input.description,
          source: input.source,
          activeVersionId: versionRow.id,
          activatedByUserId: ctx.userId ?? undefined,
          activatedAt: sql`now()`,
          updatedByUserId: ctx.userId ?? undefined,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.tools.id, existing.id));
    });

    logger.info(
      { slug, publicId: existing.publicId, version: nextVersion, workspaceId },
      "tool.declaration.publish: published new version",
    );
    return {
      publicId: existing.publicId,
      slug: existing.slug,
      version: nextVersion,
      checksum,
      published: true,
    };
  };

  const existing = await findExisting();
  if (existing) {
    return publishVersionFor(existing);
  }

  // Fresh declaration: identity row + version 1 in one transaction. The
  // existence check and this insert run in separate sessions, so two
  // concurrent publishes can both pass the check; tools_workspace_slug_idx
  // makes the second insert throw 23505 and we fall back to the version path.
  try {
    const result = await withTenantDb(async (tx) => {
      const [toolRow] = await tx
        .insert(schema.tools)
        .values({
          orgId,
          workspaceId,
          name: input.name,
          slug,
          description: input.description,
          source: input.source,
          enabled: true,
          createdByUserId: ctx.userId ?? undefined,
          updatedByUserId: ctx.userId ?? undefined,
        })
        .returning({
          id: schema.tools.id,
          publicId: schema.tools.publicId,
          slug: schema.tools.slug,
        });
      if (!toolRow) {
        throw new Error(
          "[tool.declaration.publish] Tool insert returned no row.",
        );
      }
      const [versionRow] = await tx
        .insert(schema.toolVersions)
        .values({ ...versionValues, toolId: toolRow.id, versionNumber: 1 })
        .returning({ id: schema.toolVersions.id });
      if (!versionRow) {
        throw new Error(
          "[tool.declaration.publish] Version insert returned no row.",
        );
      }
      await tx
        .update(schema.tools)
        .set({
          activeVersionId: versionRow.id,
          activatedByUserId: ctx.userId ?? undefined,
          activatedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.tools.id, toolRow.id));
      return { publicId: toolRow.publicId, slug: toolRow.slug };
    });

    logger.info(
      { slug, publicId: result.publicId, source: input.source, workspaceId },
      "tool.declaration.publish: registered new declaration",
    );
    return {
      publicId: result.publicId,
      slug: result.slug,
      version: 1,
      checksum,
      published: true,
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Concurrent publish won the race for the identity row. The loser's
      // declaration still has to land, so re-read once and take the version
      // path against the winner's row. No row on re-read means the slug is
      // held by a soft-deleted tool — surface the conflict rather than loop.
      const winner = await findExisting();
      if (winner) {
        logger.info(
          { slug, workspaceId },
          "tool.declaration.publish: lost insert race — publishing onto winner",
        );
        return publishVersionFor(winner);
      }
      throw new Error(
        `[tool.declaration.publish] Tool name "${slug}" is reserved by a deleted declaration in this workspace.`,
      );
    }
    throw err;
  }
};
