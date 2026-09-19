import {
  type CapabilityHandler,
  HandlerError,
  ORG_ONLY_WORKSPACE_ID,
} from "@oxagen/oxagen";
import { privacyDataExport } from "@oxagen/oxagen/contracts/privacy.data.export";
import { withSystemDb, schema } from "@oxagen/database";
import { isOrgAdministrator, orgMembershipRole } from "./_org_membership";
import { assertCapabilityNotRevoked } from "./lib/capability-policy-recheck";
import { eventClient } from "./event-client";
import { emitSecurityEvent } from "@oxagen/database/security";
import { logger } from "./logger";

/**
 * The real workspace that governed this queue, or null when none did.
 *
 * The org-only sentinel is not a workspace: storing it would make the
 * download recheck treat a sentinel as a place a deny can be written, which
 * it cannot. Null is the honest record for an org-only mount and for a
 * caller who named no workspace at all.
 */
function governedWorkspaceId(workspaceId: string | undefined): string | null {
  if (!workspaceId || workspaceId === ORG_ONLY_WORKSPACE_ID) return null;
  return workspaceId;
}

// CSPRNG-backed, matching the idMixin public-id default (@oxagen/database
// schema/_mixins.ts) rather than hand-rolling a weaker Math.random() generator.
function generatePublicId(prefix: string): string {
  return `${prefix}_${schema.cryptoRandom(22)}`;
}

export const privacyDataExportHandler: CapabilityHandler<
  typeof privacyDataExport
> = async (input, ctx) => {
  // A typed refusal, because this branch is now REACHABLE. The contract admits
  // every org role so a member can export their own data, which also lets a
  // machine principal through the kernel: a normal API key resolves with
  // `userId: null` (`packages/auth/src/resolvers/api-key.ts`). An uncoded throw
  // reads as `unclassified`, so the API answered 500 and the kernel audited a
  // runtime error where the truth is an authorization refusal.
  //
  // There is nothing to export for a machine: the row is keyed on `userId`, and
  // "this key's personal data" names nobody. A CLI session key, which speaks
  // for its creator, carries that person's `userId` and is unaffected.
  if (!ctx.userId) {
    throw new HandlerError({
      code: "forbidden",
      reason: "export_requires_a_person",
      message:
        "A data export is a person's right over their own data, so it cannot be requested by a machine principal",
    });
  }
  if (!ctx.orgId) {
    throw new Error("Forbidden: orgId is required");
  }
  if (input.scope === "org") {
    if (!input.orgId) throw new Error("orgId is required for org-scope export");
    // The export target must be the org the kernel governed.
    //
    // `invoke()` resolves IAM against `ctx.orgId`, so a body-supplied `orgId`
    // naming a DIFFERENT org would have the decision made in one tenant and the
    // data read from another: the target org's grants, including an explicit
    // `export_data` deny, are never evaluated, and a person holding a
    // membership in both could export the denying org's ZIP by invoking through
    // the other one. A membership-role read is not a substitute for that
    // decision; it cannot see a deny grant at all
    // (discussion_r4050819465).
    //
    // So the two must name the same org, and a caller who wants another org's
    // export invokes in that org's context, where the kernel governs it. The
    // app already passes `ctx.orgId` here, so nothing legitimate changes.
    if (input.orgId !== ctx.orgId) {
      throw new HandlerError({
        code: "forbidden",
        reason: "org_export_outside_governed_scope",
        message:
          "An organization export must be requested in that organization's own context, so its access rules govern the request",
      });
    }
    // Belt and braces on the rule the contract cannot express: `defaultRoles`
    // cannot read an input field, so Owner/Admin for org scope is enforced
    // here. Kept as a read against the target org, mirroring
    // privacy.data.erase, and re-applied by get_export_status when the archive
    // is actually read: this check authorizes a queue, not a download.
    const role = await orgMembershipRole(input.orgId, ctx.userId);
    if (!isOrgAdministrator(role)) {
      // A typed refusal, not a bare Error. Since the contract admits every org
      // role (it must, or a member could not export their own data), so this
      // branch is now the ONLY thing that refuses a member's org export, and a
      // surface classifies a refusal by `code` alone. An uncoded throw reads as
      // `unclassified`, so the app showed its generic failure instead of "an
      // organization export needs an owner or admin" and recorded a runtime
      // error rather than a policy denial; the API answered 500 rather than
      // 403.
      throw new HandlerError({
        code: "forbidden",
        reason: "org_export_requires_admin",
        message: "An organization export requires the Owner or Admin role",
      });
    }
    // And the other revocation path, which the role read above cannot see: an
    // explicit `deny` written against `export_data` itself. The note above says
    // a membership read is no substitute for the kernel's decision, and on
    // every tier but enterprise the kernel makes no decision, because its gate
    // answers `tier_gate → allow` before any policy is read. So the question is
    // asked here too, and the answer holds on the tiers most organisations are
    // on. `get_export_status` asks the same thing before it releases the
    // archive: the queue and the download are two places the mandate has to
    // still hold.
    await assertCapabilityNotRevoked(privacyDataExport, ctx, {
      reason: "org_export_not_permitted",
      message:
        "An organization export is not permitted: the export_data policy for this organization denies it",
    });
  }

  const orgId = input.scope === "org" ? (input.orgId ?? ctx.orgId) : ctx.orgId;
  // Bound at queue time so `get_export_status` can recheck `export_data` in
  // the same workspace that authorized the archive, even when the download
  // arrives under a different workspace slug in the same organization.
  const workspaceId = governedWorkspaceId(ctx.workspaceId);

  const [row] = await withSystemDb((tx) =>
    tx
      .insert(schema.privacyExportRequests)
      .values({
        publicId: generatePublicId("prexp"),
        userId: ctx.userId!,
        orgId,
        workspaceId,
        scope: input.scope,
        status: "queued",
      })
      .returning({ id: schema.privacyExportRequests.id }),
  );

  if (!row) throw new Error("Failed to create export request");

  emitSecurityEvent({
    eventType: "privacy.export_requested",
    actorUserId: ctx.userId,
    orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "export_data",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  // Dispatch async Inngest job for ZIP assembly + upload
  await eventClient.send({
    name: "privacy/export.process",
    data: { exportId: row.id, userId: ctx.userId!, orgId, scope: input.scope },
  });

  logger.info(
    { exportId: row.id, scope: input.scope, orgId },
    "privacy.data.export: queued",
  );

  return { exportId: row.id, status: "queued" as const };
};
