import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoBundleGet } from "@oxagen/oxagen/contracts/tacho.bundle.get";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import {
  readDenyGeneration,
  readWorkspaceRetention,
  requireBundleSigner,
  resolveEnrolledHost,
  resolveHostMandate,
  signBundle,
  unsignedBundle,
} from "./lib/tacho-host";
import { readWorkspaceSteering } from "./lib/tacho-steering";

/**
 * The signed policy bundle for the calling host. In this phase the bundle is
 * observe-mode with no rules: the shape, signing, etag, and status plumbing
 * are what the collector depends on; the IAM compiler that fills
 * `permissions` and `tools` lands with the authority phase (plan PR 6).
 * `context.system` carries the workspace's `must` and `should` steering
 * records (ADR-091), which the collector hands the agent at session start.
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
    const [denyGeneration, retention, steering, mandate] = await Promise.all([
      readDenyGeneration(tx as never, ctx.orgId, ctx.workspaceId),
      readWorkspaceRetention(tx as never, ctx.orgId, ctx.workspaceId),
      readWorkspaceSteering(tx as never, ctx.orgId, ctx.workspaceId),
      resolveHostMandate(tx as never, ctx, host),
    ]);
    const built = unsignedBundle(
      host,
      denyGeneration,
      retention,
      steering,
      mandate,
      now,
    );
    // `version` counts mandate changes, not fetches: the same etag keeps the
    // version it was served with, so a version sealed into a frame names one
    // mandate. That holds for the copy signed again when a host renews a quiet
    // mandate by polling without its etag (`pollEtag` in `@oxagen/tacho`).
    const unsigned = {
      ...built,
      version:
        (host.bundleEtagServed === built.etag
          ? host.bundleVersionServed
          : null) ?? built.version,
    };
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
