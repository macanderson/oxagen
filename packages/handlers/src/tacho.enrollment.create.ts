// tacho.enrollment.create.ts — the operator's way to enrol a host (spec
// section 5.2). The host row and the server-owned Tacho host scope
// (`tacho_host_v1`) are minted by lib/tacho-host-enroll.ts, which `enroll_host`
// shares; this handler decides who may enrol and as which agent key.
//
// Flow:
//   1. Auth + role gate (org Owner/Admin), same as api.key.create.
//   2. Signing material present: the enrollment HMAC secret, the bundle
//      Ed25519 key, and an HTTPS endpoint this deployment serves.
//   3. Derive the host's agentKey from the org and workspace namespaces
//      (ADR-024) and the hostname.
//   4. Mint the key and the host row in one transaction, sign the claims and
//      the initial bundle, and return everything once.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { tachoEnrollmentCreate } from "@oxagen/oxagen/contracts/tacho.enrollment.create";
import { slugFromName } from "@oxagen/oxagen/contracts/runtime.shared";
import { schema, withTenantDb } from "@oxagen/database";
import { cryptoRandom } from "@oxagen/database/schema";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq, ne } from "drizzle-orm";
import {
  API_KEY_AUTHORIZED_ROLES as AUTHORIZED_ROLES,
  resolveActorOrgRole as resolveActorRole,
  noOperatorMessage,
  resolveOperatorUserId,
} from "./lib/api-key-authz";
import {
  enrollmentDocument,
  mintHostEnrollment,
  requireEnrollmentSigning,
} from "./lib/tacho-host-enroll";
import { logger } from "./logger";

function denied(message: string): CapabilityError {
  return new CapabilityError(
    "create_tacho_enrollment",
    "authz_denied",
    message,
  );
}

/**
 * `cc-<hostname slug>`, capped at ADR-024's 18-character agent slug. The
 * hostname slug follows the one rule every name-made slug follows
 * (`slugFromName`, ADR-198), after a trailing `.local` is dropped.
 */
export function agentSlugFor(hostname: string): string {
  const slug = slugFromName(hostname.replace(/\.local$/i, ""), 15);
  return `cc-${slug.length > 0 ? slug : "host"}`;
}

export const tachoEnrollmentCreateHandler: CapabilityHandler<
  typeof tachoEnrollmentCreate
> = async (input, ctx) => {
  if (!ctx.orgId) throw denied("Forbidden: orgId is required");
  if (!ctx.workspaceId) throw denied("Forbidden: workspaceId is required");
  // A session, or the `oxagen login` key the tacho CLI carries; never a
  // machine-bound key, so an enrolled host cannot mint another enrollment.
  const operatorUserId = await resolveOperatorUserId(ctx);
  if (!operatorUserId) throw denied(noOperatorMessage(ctx));

  const actorRole = await resolveActorRole(ctx.orgId, operatorUserId);
  if (!actorRole || !AUTHORIZED_ROLES.has(actorRole)) {
    logger.warn(
      { orgId: ctx.orgId, actorRole },
      "tacho.enrollment.create: rejected — insufficient org role",
    );
    throw denied("Forbidden: only org Owners and Admins can enrol Tacho hosts");
  }

  const signing = requireEnrollmentSigning("create_tacho_enrollment");
  const issuedAt = new Date();

  const minted = await withTenantDb(async (tx) => {
    const org = await tx.query.organizations.findFirst({
      where: eq(schema.organizations.id, ctx.orgId),
      columns: { namespace: true },
    });
    const workspace = await tx.query.workspaces.findFirst({
      where: and(
        eq(schema.workspaces.id, ctx.workspaceId),
        eq(schema.workspaces.orgId, ctx.orgId),
      ),
      columns: { namespace: true },
    });
    if (!org || !workspace) {
      throw denied("Forbidden: organization or workspace namespace not found");
    }
    const baseSlug = agentSlugFor(input.hostname);
    let agentKey = `${org.namespace}.${workspace.namespace}.${baseSlug}`;
    const clash = await tx.query.tachoHosts.findFirst({
      where: and(
        eq(schema.tachoHosts.orgId, ctx.orgId),
        eq(schema.tachoHosts.agentKey, agentKey),
        ne(schema.tachoHosts.status, "revoked"),
      ),
      columns: { id: true },
    });
    if (clash) {
      agentKey = `${org.namespace}.${workspace.namespace}.${baseSlug.slice(0, 13)}-${cryptoRandom(4)}`;
    }
    return mintHostEnrollment(tx, {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: operatorUserId,
      agentKey,
      agent: null,
      facts: input,
      signing,
      issuedAt,
    });
  });

  emitSecurityEvent({
    eventType: "api_key.created",
    actorUserId: operatorUserId,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability: "create_tacho_enrollment",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      hostEnrollmentId: minted.hostEnrollmentId,
      agentKey: minted.host.agentKey,
    },
    "tacho.enrollment.create: host enrolled",
  );

  return enrollmentDocument(minted, signing, issuedAt);
};
