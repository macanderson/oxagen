import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoBundleGet } from "@oxagen/oxagen/contracts/tacho.bundle.get";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import {
  readDenyGeneration,
  requireBundleSigner,
  resolveEnrolledHost,
  signBundle,
  unsignedBundle,
} from "./lib/tacho-host";

/**
 * The signed policy bundle for the calling host. In this phase the bundle is
 * observe-mode with no rules: the shape, signing, etag, and status plumbing
 * are what the collector depends on; the IAM compiler that fills
 * `permissions` and `tools` lands with the authority phase (plan PR 6).
 */
export const tachoBundleGetHandler: CapabilityHandler<
  typeof tachoBundleGet
> = async (input, ctx) => {
  const now = new Date();
  const signer = requireBundleSigner("get_tacho_bundle");
  return withTenantDb(async (tx) => {
    const host = await resolveEnrolledHost(
      "get_tacho_bundle",
      ctx,
      tx as never,
      input.host_enrollment_id,
    );
    const denyGeneration = await readDenyGeneration(
      tx as never,
      ctx.orgId,
      ctx.workspaceId,
    );
    const unsigned = unsignedBundle(host, denyGeneration, now);
    await tx
      .update(schema.tachoHosts)
      .set({
        lastBundleFetchAt: now,
        lastSeenAt: now,
        bundleEtagServed: unsigned.etag,
        bundleVersionServed: unsigned.version,
        denyGenerationOrgSeen: denyGeneration.org,
        denyGenerationWsSeen: denyGeneration.workspace,
        updatedAt: now,
      })
      .where(eq(schema.tachoHosts.id, host.id));
    if (input.etag !== undefined && input.etag === unsigned.etag) {
      return { not_modified: true, etag: unsigned.etag, bundle: null };
    }
    return {
      not_modified: false,
      etag: unsigned.etag,
      bundle: signBundle(signer, unsigned),
    };
  });
};
