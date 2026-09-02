import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaValidateNode } from "@oxagen/oxagen/contracts/schema.validate.node";
import { validateNodeAgainstSchema } from "@oxagen/ingestion/validate";
import { getPinnedSchema } from "./schema.pinned";
import { toContractFieldErrors } from "./schema.validate.shared";
import { logger } from "./logger";

/**
 * schema.validate.node — validate a node's `{ label, properties }` against the
 * workspace's pinned **active vocabulary** and return the conformance score,
 * field-level errors, and the enforcement-derived outcome.
 *
 * Delegates to the shared `validateNodeAgainstSchema` validator (the single
 * source of truth that also backs the ingestion property-validation seam), so
 * the builder UI and ingestion agree byte-for-byte on conformance.
 *
 * When no version is pinned (registry inert), there is no vocabulary to violate,
 * so the node is fully conformant: score 1, accepted, no errors — matching the
 * validator's own "unknown label" pass-through behavior.
 */
export const schemaValidateNodeHandler: CapabilityHandler<
  typeof schemaValidateNode
> = async (input, ctx) => {
  const pinned = await getPinnedSchema(ctx.orgId, ctx.workspaceId);

  if (!pinned) {
    logger.info(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId, label: input.label },
      "schema.validate.node: no pinned version — registry inert, passthrough",
    );
    return {
      valid: true,
      conformanceScore: 1,
      errors: [],
      missingRequired: [],
      outcome: "accepted" as const,
    };
  }

  const result = validateNodeAgainstSchema(
    { label: input.label, properties: input.properties },
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
