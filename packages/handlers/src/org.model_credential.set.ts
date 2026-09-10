import { createHash } from "node:crypto";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgModelCredentialSet } from "@oxagen/oxagen/contracts/org.model_credential.set";
import { and, eq, isNull } from "drizzle-orm";
import { encrypt } from "@oxagen/crypto";
import { schema, withTenantDb } from "@oxagen/database";
import {
  invalidateModelCredentialCache,
  resolveModelCredentialKms,
} from "@oxagen/database/model-credential";
import { emitSecurityEvent } from "@oxagen/database/security";
import { toCredentialView } from "./org.model_credential.get";
import { logger } from "./logger";

/**
 * SHA-256 hex of the plaintext key.
 *
 * This is the provider-client cache key: a rotated key produces a different
 * digest, which misses the cache, so the client built on the revoked key is
 * dropped instead of retried. A digest of a key is not the key — it is
 * preimage-resistant and a vendor key is high-entropy — but it is still stored
 * beside the ciphertext rather than logged.
 */
export function keyDigest(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * The last four characters of the key — what a vendor dashboard shows, and
 * what an operator needs to tell two keys apart. The contract's minimum key
 * length is eight, so this is never the whole key.
 */
export function keyHintOf(apiKey: string): string {
  return apiKey.slice(-4);
}

/**
 * set_model_credential — store the organisation's own model-vendor key, or
 * replace the one it has (ADR-053 §2).
 *
 * Order matters and is deliberate:
 *   1. Encrypt FIRST. If the KEK is unconfigured we refuse before anything
 *      touches a column — a plaintext vendor key must never reach Postgres,
 *      not even transiently, and "degrade gracefully by storing it
 *      unencrypted" is not an option for a credential that pays an invoice.
 *   2. Upsert through withTenantDb. Nothing resolves THROUGH this table, so
 *      RLS is the filter and the caller is already inside the organisation's
 *      scope (the resolver header in `@oxagen/database/model-credential` says
 *      why this differs from the data-plane write). One live row per
 *      organisation is a partial unique index; a second set is a rotation and
 *      updates that row in place.
 *   3. Invalidate the resolver cache, so the next turn runs on the new key
 *      rather than on the old one for the rest of the TTL.
 *   4. Emit the `model_credential.set` security event. Fire-and-forget, like
 *      every other domain audit row — the audit write must never fail the
 *      mutation it records.
 *
 * The plaintext exists for the duration of the call and is returned to nobody:
 * the response is the same redacted view `get_model_credential` gives.
 */
export const orgModelCredentialSetHandler: CapabilityHandler<
  typeof orgModelCredentialSet
> = async (input, ctx) => {
  const kms = resolveModelCredentialKms();
  if (!kms) {
    throw new Error(
      "Cannot store a model credential: AUTH_TOKEN_ENCRYPTION_KEY is unset, " +
        "so the key cannot be envelope-encrypted. Refusing to store it in " +
        "plaintext.",
    );
  }
  const ciphertext = await encrypt(input.apiKey, kms.keyId, {
    adapter: kms.adapter,
  });
  const digest = keyDigest(input.apiKey);
  const hint = keyHintOf(input.apiKey);

  const now = new Date();
  const result = await withTenantDb(async (tx) => {
    const existing = await tx.query.modelCredentials.findFirst({
      where: and(
        eq(schema.modelCredentials.orgId, ctx.orgId),
        isNull(schema.modelCredentials.deletedAt),
      ),
    });

    const mutation = {
      provider: input.provider,
      keyCiphertext: ciphertext,
      keyKeyId: kms.keyId,
      keyDigest: digest,
      keyHint: hint,
      // A new or replaced key is active and unverified until the vendor has
      // been asked, so the verification stamp is reset rather than carried
      // over from the key it replaces.
      status: "active" as const,
      lastVerifiedAt: null,
      rotatedAt: now,
      updatedAt: now,
      updatedByUserId: ctx.userId ?? null,
    };

    if (existing) {
      const [updated] = await tx
        .update(schema.modelCredentials)
        .set(mutation)
        .where(eq(schema.modelCredentials.id, existing.id))
        .returning();
      return { row: updated ?? null, replaced: true };
    }
    const [inserted] = await tx
      .insert(schema.modelCredentials)
      .values({
        orgId: ctx.orgId,
        createdByUserId: ctx.userId ?? null,
        ...mutation,
      })
      .returning();
    return { row: inserted ?? null, replaced: false };
  });

  if (!result.row) {
    throw new Error("set_model_credential: the credential was not persisted");
  }

  // Live at once: the next completion resolves the new key, and the client
  // built on the superseded one is dropped rather than retried.
  invalidateModelCredentialCache(ctx.orgId);

  // SOC2 CC6.1/CC6.8 — deciding whose vendor account pays for the
  // organisation's model calls is a privileged configuration change. The row
  // records THAT it happened, by whom; the key never appears in it.
  emitSecurityEvent({
    eventType: "model_credential.set",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: "set_model_credential",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      provider: input.provider,
      replaced: result.replaced,
      // Deliberately NOT the key, not the digest, not the hint.
      surface: ctx.surface,
    },
    "org.model_credential.set: organisation model credential stored",
  );

  return toCredentialView(result.row);
};
