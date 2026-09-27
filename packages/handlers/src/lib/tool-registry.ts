// Publish identities, versions, and approval-rule invalidations in one transaction.
// The workspace rule lock serializes classification, publication, and rule authoring.
// An unchanged checksum returns without rewriting either the tool or its rules.
//
// publishTool opens its own transaction. publishToolIn runs inside a caller's
// transaction that already holds the workspace rule lock, so a steering
// publish (mcp-studio/project.ts) writes every tool of a version in one.

import { schema, withTenantDb, type Tx } from "@oxagen/database";
import type { MeasureDeclarations } from "@oxagen/oxagen/mandates/schemas";
import { and, eq, isNull, sql } from "drizzle-orm";
import { lockWorkspaceRuleSet } from "../_approval_rule";
import { invalidateApprovalRules } from "./approval-rule-invalidation";
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
  capability?:
    | "publish_tool_declaration"
    | "import_tools"
    | "publish_steering_version";
  /**
   * The registry identity, when the caller names it. A steering tool's slug
   * is its full name, `<server>__<tool>`, rather than toolSlugOf's
   * `mcp.<serverId>.<name>`.
   */
  slug?: string;
  /**
   * The version's checksum, when the caller computed it. A steering tool's is
   * the hex of its definition_hash, so the same definition in two published
   * versions is one tool version.
   */
  checksum?: string;
  /**
   * The classification the new version carries. Without it, a new version
   * copies the one the previous version carried. A steering publish passes
   * the classification tools.toml states, because the steering record is its
   * source.
   */
  classification?: VersionClassification;
  /**
   * The mandate gate's half of the classification (ADR-059 decision 6). Part
   * of the checksum: re-tagging or re-measuring a tool is a declared change
   * and publishes a version, unlike the `classification` jsonb, which a
   * reclassification edits in place.
   */
  impacts?: readonly string[];
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
  beforeNewVersion?: (
    active: ActiveClassification | null,
    tx: Tx,
  ) => Promise<void>;
}

/** The classified half of a version: all set together, per tool_versions_classification_check. */
export interface VersionClassification {
  riskGrade: "low" | "medium" | "high" | "critical";
  classification: unknown;
  classifiedAt: Date;
  classifiedByUserId: string | null;
  classificationReason: string | null;
}

/** The classification fields the mandate gate reads off the active version. */
export interface ActiveClassification {
  impacts: readonly string[];
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
    | "impacts"
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
      // The key keeps its pre-rename spelling. It names a hash input, and
      // renaming it would change every stored checksum and republish each tool.
      consequence_tags: args.impacts ?? [],
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
  return withTenantDb(async (tx) => {
    await lockWorkspaceRuleSet(tx, args.workspaceId);
    return publishToolIn(tx, args);
  });
}

/** publishTool inside a transaction that already holds the workspace rule lock. */
export async function publishToolIn(
  tx: Tx,
  args: PublishToolArgs,
): Promise<PublishedTool> {
  const { orgId, workspaceId } = args;
  const slug = args.slug ?? toolSlugOf(args);
  const checksum = args.checksum ?? toolChecksum({ ...args, slug });

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
    impacts: [...(args.impacts ?? [])],
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

  const [existing] = await tx
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
    .limit(1);
  const [latest] = existing
    ? await tx
        .select()
        .from(schema.toolVersions)
        .where(
          and(
            eq(schema.toolVersions.toolId, existing.id),
            eq(schema.toolVersions.isLatest, true),
          ),
        )
        .limit(1)
    : [];
  if (latest?.checksum === checksum && existing) {
    return {
      publicId: existing.publicId,
      versionPublicId: latest.publicId,
      slug,
      version: latest.versionNumber,
      checksum,
      published: false,
    };
  }
  await args.beforeNewVersion?.(
    latest
      ? {
          impacts: latest.impacts ?? [],
          measures: latest.measures,
          effectIdPath: latest.effectIdPath,
          classification: latest.classification,
        }
      : null,
    tx,
  );
  const before = latest
    ? {
        slug,
        version: latest.versionNumber,
        impacts: latest.impacts ?? [],
        measures: latest.measures,
        classification: latest.classification,
      }
    : null;
  const version = (latest?.versionNumber ?? 0) + 1;
  let tool = existing;
  if (!tool) {
    const [inserted] = await tx
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
    if (!inserted) throw new Error("Tool insert returned no row");
    tool = inserted;
  }
  if (latest)
    await tx
      .update(schema.toolVersions)
      .set({ isLatest: false, updatedAt: sql`now()` })
      .where(eq(schema.toolVersions.id, latest.id));
  const [versionRow] = await tx
    .insert(schema.toolVersions)
    .values({
      ...versionValues,
      toolId: tool.id,
      versionNumber: version,
      parentVersionId: latest?.id,
      ...(args.classification
        ? {
            classification: args.classification.classification,
            classifiedRiskGrade: args.classification.riskGrade,
            classifiedByUserId: args.classification.classifiedByUserId,
            classifiedAt: args.classification.classifiedAt,
            classificationReason: args.classification.classificationReason,
          }
        : latest
          ? {
              classification: latest.classification,
              classifiedRiskGrade: latest.classifiedRiskGrade,
              classifiedByUserId: latest.classifiedByUserId,
              classifiedAt: latest.classifiedAt,
              classificationReason: latest.classificationReason,
            }
          : {}),
    })
    .returning({
      id: schema.toolVersions.id,
      publicId: schema.toolVersions.publicId,
    });
  if (!versionRow) throw new Error("Tool version insert returned no row");
  await tx
    .update(schema.tools)
    .set({
      ...identityValues,
      activeVersionId: versionRow.id,
      activatedByUserId: args.userId ?? undefined,
      activatedAt: sql`now()`,
    })
    .where(eq(schema.tools.id, tool.id));
  await invalidateApprovalRules(tx, {
    orgId,
    workspaceId,
    actorUserId: args.userId,
    capability: args.capability ?? "publish_tool_declaration",
    before,
    after: {
      slug,
      version,
      impacts: versionValues.impacts,
      measures: versionValues.measures,
      classification: args.classification
        ? args.classification.classification
        : (latest?.classification ?? null),
    },
  });
  logger.info(
    { slug, workspaceId, version },
    "tool-registry: published declaration",
  );
  return {
    publicId: tool.publicId,
    versionPublicId: versionRow.publicId,
    slug,
    version,
    checksum,
    published: true,
  };
}
