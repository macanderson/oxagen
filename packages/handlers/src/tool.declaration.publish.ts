import {
  getCapability,
  HandlerError,
  type CapabilityHandler,
} from "@oxagen/oxagen";
import { toolDeclarationPublish } from "@oxagen/oxagen/contracts/tool.declaration.publish";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import {
  assertConsequenceRole,
  loadConsequenceRoles,
} from "@oxagen/iam/mandate-role";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
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
 *
 * Roles (INV-29): org Owner or Admin, or workspace Owner or Admin (the
 * contract's defaultRoles). The version's `consequence_tags`, `measures` and
 * `effect_id_path` are what the mandate gate reads (ADR-059 decision 6), so a
 * publish that changes them against the active version also needs an org
 * role the workspace names for every tag before and after the change
 * (assertConsequenceRole): only the office accountable for a consequence
 * adds, removes or re-measures it.
 *
 * The gate runs inside `invoke()` and finds the tool by `slug` equal to the
 * capability name, so a classification binds only a declaration whose slug
 * names a registered capability. Any other declaration (an external MCP
 * tool, a Stella built-in) is called without `invoke()`, and a
 * classification on it is refused as `conflict` / `consequence_not_gated`
 * rather than recorded as governing calls no mandate sees.
 */
export const toolDeclarationPublishHandler: CapabilityHandler<
  typeof toolDeclarationPublish
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    throw new Error(
      "[tool.declaration.publish] workspaceId is required (scoped capability)",
    );
  }

  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ["Owner", "Admin"], workspace: ["Owner", "Admin"] },
  );

  const slug = input.name.trim().toLowerCase();
  const classified =
    input.consequence_tags.length > 0 ||
    Object.keys(input.measures).length > 0 ||
    input.effect_id_path !== undefined;
  if (classified && getCapability(slug) === undefined) {
    throw new HandlerError({
      code: "conflict",
      reason: "consequence_not_gated",
      message: `"${slug}" names no capability invoke() dispatches, so the mandate gate never sees its calls; publish it without consequence_tags, measures or effect_id_path`,
    });
  }
  // The checksum covers every declared fact, not just the manifest body, so a
  // changed risk grade or schema republishes even when the manifest didn't.
  const checksum = sha256Hex(
    canonicalJson({
      consequence_tags: input.consequence_tags,
      description: input.description,
      effect_id_path: input.effect_id_path ?? null,
      input_schema: input.input_schema,
      manifest: input.manifest,
      measures: input.measures,
      name: slug,
      policy_group: input.policy_group ?? null,
      read_only: input.read_only,
      risk_grade: input.risk_grade,
      source: input.source,
    }),
  );

  const orgId = ctx.orgId;
  const workspaceId = ctx.workspaceId;

  interface Classification {
    consequenceTags: readonly string[];
    measures: unknown;
    effectIdPath: string | null;
  }
  const classificationKey = (c: Classification) =>
    canonicalJson({
      consequence_tags: [...new Set(c.consequenceTags)].sort(),
      effect_id_path: c.effectIdPath,
      measures: c.measures,
    });
  const declared: Classification = {
    consequenceTags: input.consequence_tags,
    measures: input.measures,
    effectIdPath: input.effect_id_path ?? null,
  };
  // `active` is the version the gate reads today; null for a fresh tool.
  const assertClassificationRole = async (active: Classification | null) => {
    const before = active ?? {
      consequenceTags: [],
      measures: {},
      effectIdPath: null,
    };
    if (classificationKey(before) === classificationKey(declared)) return;
    const tags = [
      ...new Set([...before.consequenceTags, ...declared.consequenceTags]),
    ];
    if (tags.length === 0) return;
    const overrides = await withTenantDb((tx) =>
      loadConsequenceRoles(tx, workspaceId),
    );
    await assertConsequenceRole(ctx, tags, overrides);
  };

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
    consequenceTags: input.consequence_tags,
    measures: input.measures,
    effectIdPath: input.effect_id_path ?? null,
    checksum,
    isLatest: true,
    publishedAt: sql`now()`,
    createdById: actingUserId ?? undefined,
    updatedById: actingUserId ?? undefined,
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
          consequenceTags: schema.toolVersions.consequenceTags,
          measures: schema.toolVersions.measures,
          effectIdPath: schema.toolVersions.effectIdPath,
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

    await assertClassificationRole(latest ?? null);

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
          activatedByUserId: actingUserId ?? undefined,
          activatedAt: sql`now()`,
          updatedById: actingUserId ?? undefined,
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
  await assertClassificationRole(null);
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
          createdById: actingUserId ?? undefined,
          updatedById: actingUserId ?? undefined,
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
          activatedByUserId: actingUserId ?? undefined,
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
