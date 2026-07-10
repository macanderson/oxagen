// access-request.ts — create JIT access requests (OXA-1390, Phase 3).
//
// When the resolver returns pending_approval, defineContract().invoke() calls
// createAccessRequest() to create a row in org.access_requests and returns the
// publicId in the DenialResponse so the caller can poll / display status.

import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { ResolvedPrincipal } from "@oxagen/oxagen";
import { logger } from "./logger";

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
    logger.warn(
      { capability, orgId: ctx.orgId },
      "[iam:access-request] Cannot create access request — principal is null (IAM tables may not be applied). " +
        "Returning null requestId.",
    );
    return null;
  }

  const scopeKind: "org" | "workspace" = ctx.workspaceId ? "workspace" : "org";
  const scopeId = scopeKind === "workspace" ? ctx.workspaceId : ctx.orgId;

  try {
    return await withTenantDb(async (tx) => {
      // Idempotency: the kernel calls this on every denied invoke of a
      // require_approval capability, so a principal that retries (or an agent
      // that loops) must NOT spam duplicate pending rows. If an identical
      // pending request already exists for this (org, requester, capability,
      // scope), return its publicId instead of inserting again. A residual race
      // remains under truly concurrent denials (no unique index yet); this
      // covers the realistic sequential-retry case.
      const existing = await tx
        .select({ publicId: schema.accessRequests.publicId })
        .from(schema.accessRequests)
        .where(
          and(
            eq(schema.accessRequests.orgId, ctx.orgId),
            eq(schema.accessRequests.requesterId, principal.id),
            eq(schema.accessRequests.capabilityId, capability),
            eq(schema.accessRequests.scopeKind, scopeKind),
            eq(schema.accessRequests.scopeId, scopeId),
            eq(schema.accessRequests.status, "pending"),
          ),
        )
        .limit(1);

      const existingId = existing[0]?.publicId;
      if (existingId) return existingId;

      const [row] = await tx
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
        .returning({ publicId: schema.accessRequests.publicId });

      return row?.publicId ?? null;
    });
  } catch (err) {
    logger.error(
      { err, capability, orgId: ctx.orgId },
      "[iam:access-request] Failed to create access request",
    );
    return null;
  }
}
