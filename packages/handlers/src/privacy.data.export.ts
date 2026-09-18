import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import { privacyDataExport } from "@oxagen/oxagen/contracts/privacy.data.export";
import { withSystemDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { eventClient } from "./event-client";
import { emitSecurityEvent } from "@oxagen/database/security";
import { logger } from "./logger";

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
    // Org-scope export emits a ZIP of the entire org's data. The kernel IAM gate
    // resolves roles against ctx.orgId, NOT the caller-supplied input.orgId, so a
    // body-supplied orgId could otherwise trigger a cross-tenant export. Re-verify
    // the caller's membership and role on the TARGET org here (defense-in-depth),
    // mirroring privacy.data.erase. Contract allows Owner + Admin.
    const membership = await withSystemDb((tx) =>
      tx
        .select({ role: schema.orgUsers.role })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, input.orgId!),
            eq(schema.orgUsers.userId, ctx.userId!),
          ),
        )
        .limit(1),
    );
    // org_users.role holds the membership role, NOT the capitalized
    // SystemOrgRole ("Owner") the IAM defaultRoles layer uses. It is written in
    // both casings — see privacy.data.erase, which normalises the same way —
    // and the column's CHECK is `lower(role) IN (...)`, so a case-sensitive
    // compare would deny a legitimately promoted admin.
    const role = membership[0]?.role?.toLowerCase();
    if (role !== "owner" && role !== "admin") {
      // A typed refusal, not a bare Error. Since the contract admits every org
      // role -- it must, or a member could not export their own data -- this
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
  }

  const orgId = input.scope === "org" ? (input.orgId ?? ctx.orgId) : ctx.orgId;

  const [row] = await withSystemDb((tx) =>
    tx
      .insert(schema.privacyExportRequests)
      .values({
        publicId: generatePublicId("prexp"),
        userId: ctx.userId!,
        orgId,
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
