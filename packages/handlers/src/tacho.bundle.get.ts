import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoBundleGet } from "@oxagen/oxagen/contracts/tacho.bundle.get";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import {
  readDenyGeneration,
  readWorkspaceRetention,
  requireBundleSigner,
  resolveEnrolledHost,
  resolveHostCedar,
  resolveHostMandate,
  servedBundleEtag,
  signBundle,
  unsignedBundle,
} from "./lib/tacho-host";
import { hostCedarReader } from "./lib/tacho-host-cedar";
import { hostSkillsReader } from "./lib/tacho-host-skills";
import { readWorkspaceSteering } from "./lib/tacho-steering";
import {
  type TachoPublished,
  VERSION_STORE_PUBLISHED,
} from "./tacho.published";

export interface TachoBundleGetDeps {
  /** The workspace's and the organization's published steering, for the skills and the Cedar policies. */
  published: TachoPublished;
}

/** The skills and the Cedar policies come from the versions the Postgres version store holds (#4550). */
export const defaultTachoBundleGetDeps: TachoBundleGetDeps = {
  published: VERSION_STORE_PUBLISHED,
};

/**
 * The signed policy bundle for the calling host. In this phase the bundle is
 * observe-mode with no rules: the shape, signing, etag, and status plumbing
 * are what the collector depends on; the IAM compiler that fills
 * `permissions` and `tools` lands with the authority phase (plan PR 6).
 * `context.system` carries the workspace's `must` and `should` steering
 * records (ADR-091), which the collector hands the agent at session start.
 * `skills` carries the published skills, which the collector places where
 * the harness reads user skills at session start. `cedar` carries the
 * published Cedar policies for the agents on the host's runtime, which the
 * hook decides each tool call with (lane S12).
 */
export function createTachoBundleGetHandler(
  deps: TachoBundleGetDeps,
): CapabilityHandler<typeof tachoBundleGet> {
  const skillsReader = hostSkillsReader(deps.published);
  const cedarReader = hostCedarReader(deps.published);
  return async (input, ctx) => {
    const now = new Date();
    const signer = requireBundleSigner("get_tacho_bundle");
    // The skills and the Cedar policies are read outside the tenant
    // transaction below. The version store's port opens tenant transactions
    // of its own and reads the forge, so a read made inside that transaction
    // would hold one pool connection while it waits for another, which
    // exhausts the pool under load (`withTransactionOrgWideRead` in
    // `@oxagen/database` explains). A short transaction resolves the host
    // first, so only an enrolled host reaches them, and the transaction below
    // resolves it again for the row it updates.
    const caller = await withTenantDb((tx) =>
      resolveEnrolledHost(
        "get_tacho_bundle",
        ctx,
        tx as never,
        input.host_enrollment_id,
      ),
    );
    // Both at once, so the production port answers them with one read.
    const [skills, policy] = await Promise.all([
      skillsReader.read("get_tacho_bundle", ctx, caller),
      cedarReader.read("get_tacho_bundle", ctx, caller),
    ]);
    return withTenantDb(async (tx) => {
      const host = await resolveEnrolledHost(
        "get_tacho_bundle",
        ctx,
        tx as never,
        input.host_enrollment_id,
      );
      const [denyGeneration, retention, steering, mandate, cedar] =
        await Promise.all([
          readDenyGeneration(tx as never, ctx.orgId, ctx.workspaceId),
          readWorkspaceRetention(tx as never, ctx.orgId, ctx.workspaceId),
          readWorkspaceSteering(tx as never, ctx.orgId, ctx.workspaceId),
          resolveHostMandate(tx as never, ctx, host),
          resolveHostCedar(tx as never, host, policy),
        ]);
      // The etag `unsignedBundle` gives covers the Cedar part, so a newly
      // published version reaches a host that polls with its etag.
      const built = unsignedBundle(
        host,
        denyGeneration,
        retention,
        steering,
        { ...mandate, ...cedar },
        now,
      );
      // The etag covers the skills too, so a new published version reaches
      // a host that polls with its etag. A bundle with no skills keeps the
      // etag `unsignedBundle` gives it. The control envelope publishes the
      // same etag through the same function.
      const etag = servedBundleEtag(built.etag, skills);
      // `version` counts mandate changes, not fetches: the same etag keeps the
      // version it was served with, so a version sealed into a frame names one
      // mandate. That holds for the copy signed again when a host renews a quiet
      // mandate by polling without its etag (`pollEtag` in `@oxagen/recorder`).
      const unsigned = {
        ...built,
        etag,
        version:
          (host.bundleEtagServed === etag ? host.bundleVersionServed : null) ??
          built.version,
        ...(skills === undefined ? {} : { skills }),
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
}

export const tachoBundleGetHandler = createTachoBundleGetHandler(
  defaultTachoBundleGetDeps,
);
