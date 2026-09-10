import { createHash } from "node:crypto";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgDataPlaneSet } from "@oxagen/oxagen/contracts/org.data_plane.set";
import { and, eq, isNull } from "drizzle-orm";
import { encrypt } from "@oxagen/crypto";
import { schema, withSystemDb } from "@oxagen/database";
import {
  invalidateDataPlaneCache,
  resolveDataPlaneKms,
} from "@oxagen/database/data-plane";
import { emitSecurityEvent } from "@oxagen/database/security";
import type { DataPlaneKind } from "@oxagen/tenancy";
import { assertCallerRole } from "./lib/capability-role-guard";
import { toBindingDto } from "./org.data_plane.get";
import { logger } from "./logger";

/**
 * SHA-256 over the canonical (sorted-key) JSON of the plaintext config.
 *
 * This is the store clients' pool/cache key: a rotated credential produces a
 * different digest, which misses the cache, so the pool bound to the revoked
 * password is closed instead of retried. A digest of a secret is not a secret —
 * it is preimage-resistant and the config carries a high-entropy password — but
 * it is still stored beside the ciphertext rather than logged.
 */
export function configDigest(config: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(config, Object.keys(config as object).sort()))
    .digest("hex");
}

/**
 * set_data_plane — bind one of the organisation's stores to a customer
 * endpoint, or return it to the shared platform plane (ADR-042).
 *
 * Order matters and is deliberate:
 *   0. Assert the caller's org role FIRST, before the input is touched. Binding
 *      the data plane repoints where every `withTenantDb` for this org reads and
 *      writes, and `invalidateDataPlaneCache` below makes it live at once — so a
 *      caller who can reach this can redirect the organisation's Postgres, graph
 *      and evidence to an endpoint they own. The contract restricts it to org
 *      Owner/Admin, and the kernel's IAM gate consults no policy for an org below
 *      the tier that unlocks ACLs (oxagen#2819). `scoped: false` also skips the
 *      decision-rules gate, so nothing else asks.
 *   1. Encrypt FIRST. If the KEK is unconfigured we refuse before anything
 *      touches a column — a plaintext DSN must never reach Postgres, not even
 *      transiently, and "degrade gracefully by storing it unencrypted" is not
 *      an option for a connection string.
 *   2. Upsert through withSystemDb. `org.data_planes` is platform state on the
 *      shared plane (ADR-042 §2); routing this write through withTenantDb would
 *      ask the resolver to resolve the table that decides what it returns.
 *   3. Invalidate the resolver cache and evict the organisation's dedicated
 *      pools, so the new binding is live at once rather than after the TTL and
 *      no pool survives holding a superseded credential.
 *   4. Emit the `data_plane.updated` security event. Fire-and-forget, like
 *      every other domain audit row — the audit write must never fail the
 *      mutation it records.
 */
export const orgDataPlaneSetHandler: CapabilityHandler<
  typeof orgDataPlaneSet
> = async (input, ctx) => {
  await assertCallerRole(orgDataPlaneSet, ctx);

  const kind: DataPlaneKind = input.kind;
  const dedicated = input.mode === "dedicated";

  let ciphertext: Buffer | null = null;
  let keyId: string | null = null;
  let digest: string | null = null;

  if (dedicated) {
    const kms = resolveDataPlaneKms();
    if (!kms) {
      throw new Error(
        "Cannot bind a dedicated data plane: AUTH_TOKEN_ENCRYPTION_KEY is " +
          "unset, so the connection config cannot be envelope-encrypted. " +
          "Refusing to store it in plaintext.",
      );
    }
    ciphertext = await encrypt(JSON.stringify(input.config), kms.keyId, {
      adapter: kms.adapter,
    });
    keyId = kms.keyId;
    digest = configDigest(input.config);
  }

  const now = new Date();
  const row = await withSystemDb(async (tx) => {
    // See the docblock: platform state on the shared plane, read/written before
    // any plane has been resolved. The org filter is the isolation boundary.
    // This used to say the kernel's IAM gate had already proven the caller owns
    // ctx.orgId; it had not, below the enterprise tier (oxagen#2819). The role
    // assertion at the top of the handler is what proves it now.
    const existing = await tx.query.dataPlanes.findFirst({
      where: and(
        eq(schema.dataPlanes.orgId, ctx.orgId),
        eq(schema.dataPlanes.kind, kind),
        isNull(schema.dataPlanes.deletedAt),
      ),
    });

    const mutation = {
      mode: input.mode,
      configCiphertext: ciphertext,
      configKeyId: keyId,
      configDigest: digest,
      // A newly-bound or re-credentialled plane is unverified until the health
      // check runs, and its schema version is unknown until the per-plane
      // migration runner lands (explicitly out of scope for this slice), so
      // both are reset rather than carried over from a superseded binding.
      status: "active" as const,
      schemaVersion: null,
      lastVerifiedAt: null,
      rotatedAt: dedicated ? now : null,
      updatedAt: now,
      updatedByUserId: ctx.userId ?? null,
    };

    if (existing) {
      const [updated] = await tx
        .update(schema.dataPlanes)
        .set(mutation)
        .where(eq(schema.dataPlanes.id, existing.id))
        .returning();
      return { row: updated ?? null, previousMode: existing.mode };
    }
    const [inserted] = await tx
      .insert(schema.dataPlanes)
      .values({
        orgId: ctx.orgId,
        kind,
        createdByUserId: ctx.userId ?? null,
        ...mutation,
      })
      .returning();
    return { row: inserted ?? null, previousMode: null };
  });

  if (!row.row) {
    throw new Error("set_data_plane: the binding was not persisted");
  }

  // Live at once: drop the cached binding and close any pool/driver/client
  // bound to the superseded credential.
  invalidateDataPlaneCache(ctx.orgId, kind);

  // SOC2 CC6.1/CC6.8 — moving where a tenant's traces, graph, and evidence
  // physically live is a privileged configuration change. The row records THAT
  // it happened, by whom; the config never appears in it.
  emitSecurityEvent({
    eventType: "data_plane.updated",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: "set_data_plane",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      kind,
      previousMode: row.previousMode,
      newMode: input.mode,
      // Deliberately NOT the config, not the host, not the digest.
      surface: ctx.surface,
    },
    "org.data_plane.set: organisation data-plane binding updated",
  );

  return toBindingDto({
    kind,
    row: row.row,
    config: dedicated
      ? (input.config as unknown as Record<string, unknown>)
      : undefined,
  });
};
