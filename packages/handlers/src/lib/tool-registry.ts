// tool-registry.ts — the one write into the workspace tool registry.
//
// `publish_tool_declaration` (a hand-authored manifest) and `import_tools` (a
// server's pinned tools/list, or declarations against a server) both land a
// tool here: an `agent.tools` identity row keyed (workspace, slug) and an
// immutable `agent.tool_versions` row per changed manifest, with the active
// version pinned on the identity row. An unchanged manifest is idempotent
// (`published: false`). Mirrors skill.workspace.install's shape: existence
// check, transactional insert, and a unique-violation catch for the
// concurrent-publish race.
//
// The slug is the identity (`toolSlugOf`). A tool imported from a server is
// identified per server — `mcp.<server id>.<name>` — so two servers exposing
// `search` are two registry rows, each governed under its own capability id
// (`registryCapabilityId`), each classified on its own.
//
// A new version starts with the classification of the version it replaces
// (tags, classified risk grade, who, when, why), read back from the row the
// same statement demotes, so a server shipping a new descriptor never drops a
// tool out of a class kill switch's reach. An admin reclassifies the new
// version with set_tool_classification.

import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import type { MeasureDeclarations } from "@oxagen/oxagen/mandates/schemas";
import { and, eq, isNull, sql } from "drizzle-orm";
import { canonicalJson, sha256Hex } from "../registry-digest";
import { logger } from "../logger";

export interface PublishToolArgs {
  orgId: string;
  workspaceId: string;
  userId: string | null;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  riskGrade: "low" | "medium" | "high" | "critical";
  policyGroup: string | null;
  manifest: Record<string, unknown>;
  source: "builtin" | "custom" | "mcp" | "foundry";
  /** The mcp.mcp_servers row an imported or server-declared tool belongs to. */
  mcpServerId: string | null;
  schemaOrigin: "declared" | "imported";
  /**
   * The mandate gate's half of the classification (ADR-059 decision 6). Part
   * of the checksum: re-tagging or re-measuring a tool is a declared change
   * and publishes a version, unlike the `classification` jsonb, which a
   * reclassification edits in place.
   */
  consequenceTags?: readonly string[];
  /**
   * The measure declarations the mandate gate reads limits and targets from.
   * Typed as the contract's own shape so a published version carries measures
   * the gate can parse, rather than arbitrary jsonb.
   */
  measures?: MeasureDeclarations;
  effectIdPath?: string | null;
  /**
   * Called once, with the classification the active version carries (null for
   * a fresh tool), after the idempotent case has been ruled out and before any
   * new version is written. `publish_tool_declaration` uses it to require the
   * consequence role for a change to those fields, so an unchanged republish
   * never asks for a role it does not need.
   */
  beforeNewVersion?: (active: ActiveClassification | null) => Promise<void>;
}

/** The classification fields the mandate gate reads off the active version. */
export interface ActiveClassification {
  consequenceTags: readonly string[];
  measures: unknown;
  effectIdPath: string | null;
  /**
   * The classified half of the same fact, as the row carries it. Carried so
   * the consequence-role gate can read the EFFECTIVE tags: a tool declared
   * with none that `set_tool_classification` marked `moves_money` would
   * otherwise present an empty tag set and let the gate return early.
   */
  classification: unknown;
}

interface PublishedTool {
  /** `tol_…` */
  publicId: string;
  /** `tlv_…` of the version now active. */
  versionPublicId: string;
  slug: string;
  version: number;
  checksum: string;
  published: boolean;
}

/**
 * The registry identity of a tool in its workspace: the lowercased name, or
 * for a tool of a server the name under that server, so the same name on
 * two servers is two tools.
 */
export function toolSlugOf(
  args: Pick<PublishToolArgs, "name" | "source" | "mcpServerId">,
): string {
  const name = args.name.trim().toLowerCase();
  return args.source === "mcp" && args.mcpServerId
    ? `mcp.${args.mcpServerId}.${name}`
    : name;
}

/**
 * The checksum covers every declared fact, so a changed declared risk grade or
 * schema republishes. The classification is not a declared fact and is not in
 * it.
 */
export function toolChecksum(
  args: Pick<
    PublishToolArgs,
    | "consequenceTags"
    | "description"
    | "effectIdPath"
    | "inputSchema"
    | "manifest"
    | "measures"
    | "policyGroup"
    | "readOnly"
    | "riskGrade"
    | "source"
  > & { slug: string },
): string {
  return sha256Hex(
    canonicalJson({
      consequence_tags: args.consequenceTags ?? [],
      description: args.description,
      effect_id_path: args.effectIdPath ?? null,
      input_schema: args.inputSchema,
      manifest: args.manifest,
      measures: args.measures ?? {},
      name: args.slug,
      policy_group: args.policyGroup,
      read_only: args.readOnly,
      risk_grade: args.riskGrade,
      source: args.source,
    }),
  );
}

export async function publishTool(
  args: PublishToolArgs,
): Promise<PublishedTool> {
  const { orgId, workspaceId } = args;
  const slug = toolSlugOf(args);
  const checksum = toolChecksum({ ...args, slug });

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
    inputSchema: args.inputSchema,
    readOnly: args.readOnly,
    riskGrade: args.riskGrade,
    policyGroup: args.policyGroup,
    manifest: args.manifest,
    checksum,
    schemaOrigin: args.schemaOrigin,
    // The column is a mutable text[]; copy so a caller's readonly tags fit.
    consequenceTags: [...(args.consequenceTags ?? [])],
    measures: args.measures ?? {},
    effectIdPath: args.effectIdPath ?? null,
    isLatest: true,
    publishedAt: sql`now()`,
    createdById: args.userId ?? undefined,
    updatedById: args.userId ?? undefined,
  };

  const identityValues = {
    name: args.name,
    description: args.description,
    source: args.source,
    mcpServerId: args.mcpServerId,
    updatedById: args.userId ?? undefined,
    updatedAt: sql`now()`,
  };

  // Version-publish path against an existing identity row: idempotent when the
  // latest version already carries this checksum, otherwise latest+1.
  const publishVersionFor = async (existing: {
    id: string;
    publicId: string;
    slug: string;
  }): Promise<PublishedTool> => {
    const [latest] = await withTenantDb((tx) =>
      tx
        .select({
          id: schema.toolVersions.id,
          publicId: schema.toolVersions.publicId,
          versionNumber: schema.toolVersions.versionNumber,
          checksum: schema.toolVersions.checksum,
          consequenceTags: schema.toolVersions.consequenceTags,
          measures: schema.toolVersions.measures,
          effectIdPath: schema.toolVersions.effectIdPath,
          classification: schema.toolVersions.classification,
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
        "tool-registry: idempotent — checksum unchanged",
      );
      return {
        publicId: existing.publicId,
        versionPublicId: latest.publicId,
        slug: existing.slug,
        version: latest.versionNumber,
        checksum,
        published: false,
      };
    }

    await args.beforeNewVersion?.(
      latest
        ? {
            consequenceTags: latest.consequenceTags ?? [],
            measures: latest.measures,
            effectIdPath: latest.effectIdPath,
            classification: latest.classification,
          }
        : null,
    );

    const nextVersion = (latest?.versionNumber ?? 0) + 1;
    const versionPublicId = await withTenantDb(async (tx) => {
      // The demote locks the row and returns its classification as committed
      // at that moment, so a reclassification that landed after the read
      // above is the one carried.
      const [carried] = latest
        ? await tx
            .update(schema.toolVersions)
            .set({ isLatest: false, updatedAt: sql`now()` })
            .where(eq(schema.toolVersions.id, latest.id))
            .returning({
              classification: schema.toolVersions.classification,
              classifiedRiskGrade: schema.toolVersions.classifiedRiskGrade,
              classifiedByUserId: schema.toolVersions.classifiedByUserId,
              classifiedAt: schema.toolVersions.classifiedAt,
              classificationReason: schema.toolVersions.classificationReason,
            })
        : [];
      const [versionRow] = await tx
        .insert(schema.toolVersions)
        .values({
          ...versionValues,
          ...carried,
          toolId: existing.id,
          versionNumber: nextVersion,
          parentVersionId: latest?.id ?? undefined,
        })
        .returning({
          id: schema.toolVersions.id,
          publicId: schema.toolVersions.publicId,
        });
      if (!versionRow) {
        throw new Error("[tool-registry] Version insert returned no row.");
      }
      await tx
        .update(schema.tools)
        .set({
          ...identityValues,
          activeVersionId: versionRow.id,
          activatedByUserId: args.userId ?? undefined,
          activatedAt: sql`now()`,
        })
        .where(eq(schema.tools.id, existing.id));
      return versionRow.publicId;
    });

    logger.info(
      { slug, publicId: existing.publicId, version: nextVersion, workspaceId },
      "tool-registry: published new version",
    );
    return {
      publicId: existing.publicId,
      versionPublicId,
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
  await args.beforeNewVersion?.(null);
  try {
    const result = await withTenantDb(async (tx) => {
      const [toolRow] = await tx
        .insert(schema.tools)
        .values({
          orgId,
          workspaceId,
          slug,
          enabled: true,
          createdById: args.userId ?? undefined,
          ...identityValues,
        })
        .returning({
          id: schema.tools.id,
          publicId: schema.tools.publicId,
          slug: schema.tools.slug,
        });
      if (!toolRow) {
        throw new Error("[tool-registry] Tool insert returned no row.");
      }
      const [versionRow] = await tx
        .insert(schema.toolVersions)
        .values({ ...versionValues, toolId: toolRow.id, versionNumber: 1 })
        .returning({
          id: schema.toolVersions.id,
          publicId: schema.toolVersions.publicId,
        });
      if (!versionRow) {
        throw new Error("[tool-registry] Version insert returned no row.");
      }
      await tx
        .update(schema.tools)
        .set({
          activeVersionId: versionRow.id,
          activatedByUserId: args.userId ?? undefined,
          activatedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.tools.id, toolRow.id));
      return {
        publicId: toolRow.publicId,
        slug: toolRow.slug,
        versionPublicId: versionRow.publicId,
      };
    });

    logger.info(
      { slug, publicId: result.publicId, source: args.source, workspaceId },
      "tool-registry: registered new declaration",
    );
    return {
      publicId: result.publicId,
      versionPublicId: result.versionPublicId,
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
          "tool-registry: lost insert race — publishing onto winner",
        );
        return publishVersionFor(winner);
      }
      throw new Error(
        `[tool-registry] Tool name "${slug}" is reserved by a deleted declaration in this workspace.`,
      );
    }
    throw err;
  }
}
