// audit-exempt: read-only — reads the org's security_events and mutates nothing; the kernel capability.invoke_* audit records the access.
//
// audit.log.query handler.
//
// Reads the security audit spine and returns a newest-first page. Which feed
// a call reads is decided before any row is read, by the role gate
// (apps/app/ARCHITECTURE.md §3.2, INV-29; the kernel's IAM check allows every
// capability for a non-enterprise org):
//
//   - the call's own workspace, named: its workspace Owner, or an org Owner or
//     Admin;
//   - another workspace, or the whole organization: an org Owner or Admin;
//   - a workspace-scoped call naming no workspace: the whole organization for
//     an org Owner or Admin, its own workspace for that workspace's Owner.
//
// An organization-level call carries the ORG_ONLY_WS sentinel, which names no
// workspace, so a Member reading from the organization is refused rather than
// handed an empty page filtered on a workspace that does not exist. Every
// refusal is HandlerError { code: "forbidden" } from assertOrgRole, which the
// API maps to 403 and the app to `denied`. An API key acts as its creator
// (resolveActingUserId).
import type { CapabilityHandler } from "@oxagen/oxagen";
import { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import { withSystemDb } from "@oxagen/database";
import {
  assertOrgRole,
  resolveActingUserId,
  resolveActorOrgRole,
} from "@oxagen/iam/org-role";
import { auditConditions, ORG_ONLY_WS, readAuditEvents } from "./audit.shared";
import { logger } from "./logger";

/** The org roles that read the whole organization's record. */
export const ORG_AUDIT_ROLES: readonly string[] = ["Owner", "Admin"];
/** The workspace role that reads its own workspace's record. */
const WORKSPACE_AUDIT_ROLES: readonly string[] = ["Owner"];

export const auditLogQueryHandler: CapabilityHandler<
  typeof auditLogQuery
> = async (input, ctx) => {
  const { orgId } = ctx;
  const actingUserId = await resolveActingUserId(ctx);
  const ownWorkspace =
    ctx.workspaceId && ctx.workspaceId !== ORG_ONLY_WS ? ctx.workspaceId : null;
  const requested = input.workspaceId ?? null;

  let workspaceFilter: string | null;
  if (ownWorkspace !== null && requested === ownWorkspace) {
    await assertOrgRole(
      { orgId, workspaceId: ownWorkspace, userId: actingUserId },
      { org: ORG_AUDIT_ROLES, workspace: WORKSPACE_AUDIT_ROLES },
    );
    workspaceFilter = ownWorkspace;
  } else if (requested !== null || ownWorkspace === null) {
    await assertOrgRole(
      { orgId, userId: actingUserId },
      { org: ORG_AUDIT_ROLES },
    );
    workspaceFilter = requested;
  } else {
    const orgRole =
      actingUserId === null
        ? null
        : await resolveActorOrgRole(orgId, actingUserId);
    if (orgRole !== null && ORG_AUDIT_ROLES.includes(orgRole)) {
      workspaceFilter = null;
    } else {
      await assertOrgRole(
        { orgId, workspaceId: ownWorkspace, userId: actingUserId },
        { org: ORG_AUDIT_ROLES, workspace: WORKSPACE_AUDIT_ROLES },
      );
      workspaceFilter = ownWorkspace;
    }
  }

  // The security spine is the only one left (ADR-043 removed playbook_events),
  // so `source` "all" and "security" read the same rows.
  const rows = await withSystemDb((tx) =>
    readAuditEvents(tx, auditConditions(orgId, workspaceFilter, input), {
      limit: input.limit + 1,
      offset: input.offset,
    }),
  );

  const hasMore = rows.length > input.limit;
  const events = rows.slice(0, input.limit).map((r) => r.event);

  logger.info(
    { orgId, source: input.source, returned: events.length, hasMore },
    "audit.log.query: audit feed queried",
  );

  return {
    events,
    total: events.length,
    hasMore,
    limit: input.limit,
    offset: input.offset,
  };
};
