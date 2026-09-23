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
    // mandate.
    const unsigned = {
      ...built,
      version:
        (host.bundleEtagServed === built.etag
          ? host.bundleVersionServed
          : null) ?? built.version,
    };
    // A host measures a mandate's freshness from its signed `issued_at`
    // whenever its daemon has not confirmed it in the running process: after
    // a restart, and in the hook when the daemon does not answer. Answering
    // `not_modified` for ever let an unchanged mandate outlive its signed
    // window, and in enforce mode the next hiccup denied every mutating tool.
    // So a host whose bundle was issued more than half a window ago is sent
    // the same mandate signed again. `lastBundleFetchAt` is when this host was
    // last sent a signed bundle; a host with none holds its enrollment bundle,
    // issued when the row was created.
    const issuedAt = host.lastBundleFetchAt ?? host.createdAt;
    const window =
      Date.parse(unsigned.expires_at) - Date.parse(unsigned.issued_at);
    const notModified =
      input.etag !== undefined &&
      input.etag === unsigned.etag &&
      now.getTime() - issuedAt.getTime() < window / 2;
    await tx
      .update(schema.tachoHosts)
      .set({
        ...(notModified ? {} : { lastBundleFetchAt: now }),
        lastSeenAt: now,
        bundleEtagServed: unsigned.etag,
        bundleVersionServed: unsigned.version,
        denyGenerationOrgSeen: denyGeneration.org,
        denyGenerationWsSeen: denyGeneration.workspace,
        updatedAt: now,
      })
      .where(eq(schema.tachoHosts.id, host.id));
    if (notModified) {
      return { not_modified: true, etag: unsigned.etag, bundle: null };
    }
    return {
      not_modified: false,
      etag: unsigned.etag,
      bundle: signBundle(signer, unsigned),
    };
  });
};
