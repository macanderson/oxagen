import {
  getCapability,
  HandlerError,
  type CapabilityHandler,
} from "@oxagen/oxagen";
import { toolDeclarationPublish } from "@oxagen/oxagen/contracts/tool.declaration.publish";
import { unionConsequenceTags } from "@oxagen/oxagen/contracts/tool.classification";
import type { Tx } from "@oxagen/database";
import {
  assertConsequenceRole,
  loadConsequenceRoles,
} from "@oxagen/iam/mandate-role";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { canonicalJson } from "./registry-digest";
import { publishTool, type ActiveClassification } from "./lib/tool-registry";

/**
 * Publish one hand-authored tool declaration into the workspace registry
 * (origin `declared`, no server). The write itself is `publishTool`
 * (lib/tool-registry.ts), shared with `import_tools`.
 *
 * Roles (INV-29): org Owner or Admin, or workspace Owner or Admin (the
 * contract's defaultRoles). The version's `consequence_tags`, `measures` and
 * `effect_id_path` are what the mandate gate reads (ADR-059 decision 6), so a
 * publish that changes them against the active version also needs an org
 * role the workspace names for every tag before and after the change
 * (assertConsequenceRole): only the office accountable for a consequence
 * adds, removes or re-measures it. `publishTool` calls that check through
 * `beforeNewVersion`, after it has read the version the gate reads today and
 * before it writes a new one, so an idempotent republish never asks for a
 * role it does not need.
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

  const workspaceId = ctx.workspaceId;
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

  const classificationKey = (c: ActiveClassification) =>
    canonicalJson({
      consequence_tags: [...new Set(c.consequenceTags)].sort(),
      effect_id_path: c.effectIdPath,
      measures: c.measures,
    });
  const declared: ActiveClassification = {
    consequenceTags: input.consequence_tags,
    measures: input.measures,
    effectIdPath: input.effect_id_path ?? null,
    // The incoming declaration carries no classification of its own; the
    // active version's is what the gate below unions in.
    classification: null,
  };
  // `active` is the version the gate reads today; null for a fresh tool.
  const assertClassificationRole = async (
    active: ActiveClassification | null,
    tx: Tx,
  ) => {
    const before = active ?? {
      consequenceTags: [],
      measures: {},
      effectIdPath: null,
      classification: null,
    };
    if (classificationKey(before) === classificationKey(declared)) return;
    // The EFFECTIVE tags, through the one function every reader of this fact
    // uses: what the version declares, what it is classified with, and what
    // this declaration would leave it declaring. Reading only the declared
    // columns let a tool with no declared tag that an administrator had
    // classified `moves_money` fall through the `length === 0` return, so its
    // declaration — including the measures a rule's ceilings are read from —
    // could be rewritten by someone not accountable for money.
    const tags = [
      ...new Set([
        ...unionConsequenceTags(before),
        ...declared.consequenceTags,
      ]),
    ];
    if (tags.length === 0) return;
    const overrides = await loadConsequenceRoles(tx, workspaceId);
    await assertConsequenceRole(
      { ...ctx, userId: actingUserId, apiKeyId: null },
      tags,
      overrides,
      tx,
    );
  };

  const published = await publishTool({
    orgId: ctx.orgId,
    workspaceId,
    userId: actingUserId,
    name: input.name,
    description: input.description,
    inputSchema: input.input_schema,
    readOnly: input.read_only,
    riskGrade: input.risk_grade,
    policyGroup: input.policy_group ?? null,
    manifest: input.manifest,
    source: input.source,
    mcpServerId: null,
    schemaOrigin: "declared",
    consequenceTags: input.consequence_tags,
    measures: input.measures,
    effectIdPath: input.effect_id_path ?? null,
    beforeNewVersion: assertClassificationRole,
  });

  return {
    publicId: published.publicId,
    slug: published.slug,
    version: published.version,
    checksum: published.checksum,
    published: published.published,
  };
};
