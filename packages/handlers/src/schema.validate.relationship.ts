import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaValidateRelationship } from "@oxagen/oxagen/contracts/schema.validate.relationship";
import { validateRelationshipAgainstSchema } from "@oxagen/ingestion/validate";
import { getPinnedSchema } from "./schema.pinned";
import { toContractFieldErrors } from "./schema.validate.shared";
import { logger } from "./logger";

/**
 * schema.validate.relationship — validate a relationship's
 * `{ type, startLabel, endLabel, properties }` against the workspace's pinned
 * **active vocabulary**, returning conformance score, field-level errors
 * (including start/end endpoint-constraint violations), missing required
 * properties, and the enforcement-derived outcome.
 *
 * Delegates to the shared `validateRelationshipAgainstSchema` validator (same
 * source of truth as ingestion). No pinned version → passthrough (score 1,
 * accepted), matching the validator's unknown-type behavior.
 */
export const schemaValidateRelationshipHandler: CapabilityHandler<
  typeof schemaValidateRelationship
> = async (input, ctx) => {
  const pinned = await getPinnedSchema(ctx.orgId, ctx.workspaceId);

  if (!pinned) {
    logger.info(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId, type: input.type },
      "schema.validate.relationship: no pinned version — registry inert, passthrough",
    );
    return {
      valid: true,
      conformanceScore: 1,
      errors: [],
      missingRequired: [],
      outcome: "accepted" as const,
    };
  }

  const result = validateRelationshipAgainstSchema(
    {
      type: input.type,
      startLabel: input.startLabel,
      endLabel: input.endLabel,
      properties: input.properties,
    },
    pinned,
  );

  return {
    valid: result.valid,
    conformanceScore: result.conformanceScore,
    errors: toContractFieldErrors(result.errors),
    missingRequired: result.missingRequired,
    outcome: result.outcome,
  };
};
