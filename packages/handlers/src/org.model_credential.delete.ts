import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgModelCredentialDelete } from "@oxagen/oxagen/contracts/org.model_credential.delete";
import { and, eq, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { invalidateModelCredentialCache } from "@oxagen/database/model-credential";
import { emitSecurityEvent } from "@oxagen/database/security";
import { toCredentialView } from "./org.model_credential.get";
import { logger } from "./logger";

/**
 * delete_model_credential — remove the organisation's stored key and return
 * it to the platform key (ADR-053 §2).
 *
 * The live row is soft-deleted, so the audit trail keeps that a key existed
 * and when it went while the envelope stops being live. The partial unique
 * index is on `deleted_at IS NULL`, so the next set inserts a fresh row
 * beside the retired one rather than reviving it.
 *
 * Idempotent: deleting when nothing is stored is not an error, because the
 * state the caller asked for is the state they have. It is also not an audit
 * row — `model_credential.revoked` is emitted only when a key was actually
 * removed, so a row in the log means a credential stopped paying.
 *
 * withTenantDb, for the reason the set handler gives: nothing resolves THROUGH
 * this table, so RLS is the filter.
 */
export const orgModelCredentialDeleteHandler: CapabilityHandler<
  typeof orgModelCredentialDelete
> = async (_input, ctx) => {
  const now = new Date();
  const removed = await withTenantDb(async (tx) => {
    const existing = await tx.query.modelCredentials.findFirst({
      where: and(
        eq(schema.modelCredentials.orgId, ctx.orgId),
        isNull(schema.modelCredentials.deletedAt),
      ),
    });
    if (!existing) return false;
    await tx
      .update(schema.modelCredentials)
      .set({
        deletedAt: now,
        deletedByUserId: ctx.userId ?? null,
        updatedAt: now,
        updatedByUserId: ctx.userId ?? null,
      })
      .where(eq(schema.modelCredentials.id, existing.id));
    return true;
  });

  // Live at once: a turn already resolved onto the customer's key must not
  // keep charging their vendor account for the rest of the TTL.
  invalidateModelCredentialCache(ctx.orgId);

  if (removed) {
    // SOC2 CC6.1/CC6.8 — moving the organisation's model calls back onto the
    // platform key (and onto billed assistant usage) is a privileged
    // configuration change. The row records THAT it happened, by whom.
    emitSecurityEvent({
      eventType: "model_credential.revoked",
      actorUserId: ctx.userId ?? null,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: "delete_model_credential",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });
  }

  logger.info(
    {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      removed,
      surface: ctx.surface,
    },
    removed
      ? "org.model_credential.delete: organisation model credential removed"
      : "org.model_credential.delete: no credential was stored (no-op)",
  );

  return toCredentialView(null);
};
