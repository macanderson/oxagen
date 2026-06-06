// access-request.ts — create JIT access requests (OXA-1390, Phase 3).
//
// When the resolver returns pending_approval, defineContract().invoke() calls
// createAccessRequest() to create a row in org.access_requests and returns the
// publicId in the DenialResponse so the caller can poll / display status.

import { withTenantDb, schema } from "@oxagen/database";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { ResolvedPrincipal } from "@oxagen/oxagen";

export interface CreateAccessRequestArgs {
  capability: string;
  ctx: CapabilityContext;
  principal: ResolvedPrincipal | null;
  justification?: string;
}

/**
 * Insert an access_request row and return its publicId. Returns null when
 * the principal is null (graceful degradation — IAM tables may not exist).
 *
 * The returned publicId (arq_...) is included in the DenialResponse so the
 * client can poll for approval status.
 */
export async function createAccessRequest(
  args: CreateAccessRequestArgs,
): Promise<string | null> {
  const { capability, ctx, principal, justification } = args;

  if (!principal) {
    // Cannot create an access request without a resolved principal.
    console.warn(
      "[iam:access-request] Cannot create access request — principal is null (IAM tables may not be applied). " +
        "Returning null requestId.",
    );
    return null;
  }

  const scopeKind: "org" | "workspace" = ctx.workspaceId ? "workspace" : "org";
  const scopeId = scopeKind === "workspace" ? ctx.workspaceId : ctx.orgId;

  try {
    const [row] = await withTenantDb((tx) =>
      tx
        .insert(schema.accessRequests)
        .values({
          orgId: ctx.orgId,
          requesterId: principal.id,
          capabilityId: capability,
          scopeKind,
          scopeId,
          status: "pending",
          justification: justification ?? null,
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .returning({ publicId: schema.accessRequests.publicId }),
    );

    return row?.publicId ?? null;
  } catch (err) {
    console.error("[iam:access-request] Failed to create access request:", err);
    return null;
  }
}
