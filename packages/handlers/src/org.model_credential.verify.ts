// audit-exempt: verifying writes no key and reveals none — it asks the vendor
// whether a key is accepted and reports the vendor's answer. The kernel's
// capability.invoke_* audit records who asked; only the mutations
// (org.model_credential.set / .delete) warrant a model_credential.* row.
import { probeModelCredential } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgModelCredentialVerify } from "@oxagen/oxagen/contracts/org.model_credential.verify";
import { and, eq, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { loadModelCredential } from "@oxagen/database/model-credential";
import { logger } from "./logger";

/**
 * verify_model_credential — ask the vendor whether a key is accepted, without
 * spending tokens (ADR-053 §2).
 *
 * Two shapes, told apart by the input:
 *   - `provider` + `apiKey`: a candidate the settings page wants checked
 *     before it is stored. Nothing is read or written; the answer is the
 *     vendor's.
 *   - neither: the organisation's stored key, opened through the resolver (the
 *     one place the envelope is ever opened) and checked the same way. On
 *     success `last_verified_at` is stamped on the live row so the settings
 *     page can show when the key last worked. A refusal stamps nothing: the
 *     column records the last time the vendor said yes.
 *
 * The contract's pairing rule already rejects one field without the other;
 * the check below is for a direct caller, and refuses rather than quietly
 * verifying the stored key under a provider the caller did not mean.
 *
 * A refusal is reported, not thrown. The vendor's message about the key is
 * the output the operator needs. The key itself is in one request header and
 * nowhere else — the probe scrubs it from any message that echoes it.
 */
export const orgModelCredentialVerifyHandler: CapabilityHandler<
  typeof orgModelCredentialVerify
> = async (input, ctx) => {
  const hasProvider = input.provider !== undefined;
  const hasKey = input.apiKey !== undefined;
  if (hasProvider !== hasKey) {
    throw new Error(
      "verify_model_credential: provider and apiKey must be given together " +
        "to verify a candidate key, or both omitted to verify the stored key",
    );
  }

  if (input.provider !== undefined && input.apiKey !== undefined) {
    const probe = await probeModelCredential({
      provider: input.provider,
      apiKey: input.apiKey,
    });
    logger.info(
      // Never the key: provider and the vendor's verdict only.
      {
        orgId: ctx.orgId,
        provider: input.provider,
        candidate: true,
        ok: probe.ok,
        latencyMs: probe.latencyMs,
        surface: ctx.surface,
      },
      "org.model_credential.verify: candidate key checked against the vendor",
    );
    return {
      ok: probe.ok,
      provider: input.provider,
      latencyMs: probe.latencyMs,
      error: probe.error,
    };
  }

  const stored = await loadModelCredential(ctx.orgId);
  if (!stored) {
    throw new Error("No model credential is stored for this organisation");
  }
  const probe = await probeModelCredential({
    provider: stored.provider,
    apiKey: stored.apiKey,
  });

  if (probe.ok) {
    // A health fact, not an edit: the audit columns are left alone so
    // `updated_at` keeps meaning "the last time somebody changed the key".
    const now = new Date();
    await withTenantDb((tx) =>
      tx
        .update(schema.modelCredentials)
        .set({ lastVerifiedAt: now })
        .where(
          and(
            eq(schema.modelCredentials.orgId, ctx.orgId),
            isNull(schema.modelCredentials.deletedAt),
          ),
        ),
    );
  }

  logger.info(
    {
      orgId: ctx.orgId,
      provider: stored.provider,
      candidate: false,
      ok: probe.ok,
      latencyMs: probe.latencyMs,
      surface: ctx.surface,
    },
    "org.model_credential.verify: stored key checked against the vendor",
  );
  return {
    ok: probe.ok,
    provider: stored.provider,
    latencyMs: probe.latencyMs,
    error: probe.error,
  };
};
