import type { CapabilityHandler } from "@oxagen/oxagen";
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
  if (!ctx.userId) {
    throw new Error(
      "Unauthorized: authentication required to request a data export",
    );
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
      throw new Error("Forbidden: org export requires Owner or Admin role");
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
