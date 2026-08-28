// access-request.ts — create just-in-time access requests.
//
// When the resolver returns pending_approval, the kernel calls
// createAccessRequest() to create a row in org.access_requests and returns the
// publicId in the DenialResponse so the caller can poll / display status.

import { withTenantDb, schema, isUniqueViolation } from "@oxagen/database";
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

interface PendingLookup {
  orgId: string;
  requesterId: string;
  capabilityId: string;
  scopeKind: "org" | "workspace";
  scopeId: string;
}

/** Find the surviving pending row for a (org, requester, capability, scope) tuple. */
function findPending(lookup: PendingLookup): Promise<string | undefined> {
  return withTenantDb(async (tx) => {
    const existing = await tx
      .select({ publicId: schema.accessRequests.publicId })
      .from(schema.accessRequests)
      .where(
        and(
          eq(schema.accessRequests.orgId, lookup.orgId),
          eq(schema.accessRequests.requesterId, lookup.requesterId),
          eq(schema.accessRequests.capabilityId, lookup.capabilityId),
          eq(schema.accessRequests.scopeKind, lookup.scopeKind),
          eq(schema.accessRequests.scopeId, lookup.scopeId),
          eq(schema.accessRequests.status, "pending"),
        ),
      )
      .limit(1);

    return existing[0]?.publicId;
  });
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
  const lookup: PendingLookup = {
    orgId: ctx.orgId,
    requesterId: principal.id,
    capabilityId: capability,
    scopeKind,
    scopeId,
  };

  try {
    // Idempotency fast path: the kernel calls this on every denied invoke of a
    // require_approval capability, so a principal that retries (or an agent
    // that loops) must NOT spam duplicate pending rows. If an identical
    // pending request already exists, return its publicId instead of
    // inserting again. This covers the common sequential-retry case without
    // an unnecessary insert attempt.
    const existingId = await findPending(lookup);
    if (existingId) return existingId;

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
    // The pre-check above is not race-safe on its own: two concurrent denials
    // for the same tuple can both pass it and both attempt the insert. The
    // partial unique index access_requests_pending_dedupe_idx (org_id,
    // requester_id, capability_id, scope_kind, scope_id) WHERE status='pending'
    // makes the loser's insert fail with 23505 — re-select and return the
    // winner's row instead of surfacing the violation as a failure.
    if (isUniqueViolation(err)) {
      const raceWinnerId = await findPending(lookup);
      if (raceWinnerId) return raceWinnerId;
      logger.warn(
        { capability, orgId: ctx.orgId },
        "[iam:access-request] Unique violation on insert but no pending row found on re-select " +
          "(status changed mid-race). Returning null requestId.",
      );
      return null;
    }

    logger.error(
      { err, capability, orgId: ctx.orgId },
      "[iam:access-request] Failed to create access request",
    );
    return null;
  }
}
