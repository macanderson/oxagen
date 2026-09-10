import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  auditLogQuery,
  type AuditEvent,
} from "@oxagen/oxagen/contracts/audit.log.query";
import { schema, withSystemDb, type Tx } from "@oxagen/database";
import { and, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { logger } from "./logger";

/**
 * audit.log.query handler.
 *
 * Reads the append-only audit spine and returns a newest-first feed. The read
 * goes through withSystemDb, so RLS is off for it and tenant isolation is
 * enforced HERE, explicitly: EVERY query filters by ctx.orgId. Never relax
 * this — a missing org filter would leak another tenant's audit trail
 * (SOC 2 §0).
 *
 * Workspace narrowing defaults to ctx.workspaceId, and widening past it is an
 * org-admin act that is checked here rather than assumed. The org Governance
 * hub still gets the whole org's feed, because the Owner/Admin who opens it
 * passes that check; a member scoped to one workspace no longer does. The
 * contract is sensitivity "high" on the api/mcp/agent/cli surfaces, so the
 * caller asking to widen can be a prompt-injected agent holding a workspace
 * role — the kernel IAM gate resolves that role against the workspace, and
 * nothing below it re-asked about the org until now.
 *
 * Widening is refused rather than silently narrowed: a caller who names another
 * workspace and gets this workspace's events back has been handed a wrong
 * answer that looks like a right one.
 *
 * Pagination is done by over-fetching (offset+limit+1), ordering by occurredAt
 * desc, then slicing the window. Correct and bounded for the realistic admin
 * use case.
 */

/**
 * Whether the caller holds an org-level role that may read the whole org's
 * audit feed. Mirrors the contract's `defaultRoles.org` (Owner + Admin) and the
 * target-org re-verification in privacy.data.export.
 *
 * org_users.role holds the membership role, NOT the capitalized SystemOrgRole
 * ("Owner") the IAM defaultRoles layer uses. It is written in both casings and
 * the column's CHECK is `lower(role) IN (...)`, so a case-sensitive compare
 * would deny a legitimately promoted admin.
 */
async function callerHoldsOrgAuditRole(
  tx: Tx,
  orgId: string,
  userId: string | null,
): Promise<boolean> {
  // An API key or an unauthenticated surface has no org membership to read, so
  // it stays at its own workspace scope.
  if (!userId) return false;

  const membership = await tx
    .select({ role: schema.orgUsers.role })
    .from(schema.orgUsers)
    .where(and(eq(schema.orgUsers.orgId, orgId), eq(schema.orgUsers.userId, userId)))
    .limit(1);

  const role = membership[0]?.role?.toLowerCase();
  return role === "owner" || role === "admin";
}

export const auditLogQueryHandler: CapabilityHandler<
  typeof auditLogQuery
> = async (input, ctx) => {
  const { orgId } = ctx;
  const window = input.offset + input.limit + 1; // +1 to detect hasMore
  const fromDate = input.from ? new Date(input.from) : null;
  const toDate = input.to ? new Date(input.to) : null;

  const wantSecurity = input.source === "all" || input.source === "security";

  const events: AuditEvent[] = [];

  await withSystemDb(async (tx) => {
    // Resolve the workspace predicate before any spine is read, so a refusal
    // costs no query and every spine added later inherits the same decision.
    const requested = input.workspaceId ?? null;
    const widens = requested === null || requested !== ctx.workspaceId;
    const mayReadOrgWide = widens
      ? await callerHoldsOrgAuditRole(tx, orgId, ctx.userId)
      : false;

    let workspaceFilter: string | null;
    if (requested !== null) {
      if (requested !== ctx.workspaceId && !mayReadOrgWide) {
        throw new Error(
          "Forbidden: reading another workspace's audit events requires an org Owner or Admin role",
        );
      }
      workspaceFilter = requested;
    } else if (mayReadOrgWide) {
      workspaceFilter = null; // the whole org's feed
    } else if (ctx.workspaceId) {
      workspaceFilter = ctx.workspaceId;
    } else {
      // No org role and no workspace scope leaves nothing this caller may read.
      throw new Error(
        "Forbidden: the org-wide audit feed requires an org Owner or Admin role",
      );
    }

    if (wantSecurity) {
      const conds: SQL[] = [eq(schema.securityEvents.orgId, orgId)];
      if (workspaceFilter !== null)
        conds.push(eq(schema.securityEvents.workspaceId, workspaceFilter));
      if (input.eventType)
        conds.push(eq(schema.securityEvents.eventType, input.eventType));
      if (input.actorUserId)
        conds.push(eq(schema.securityEvents.actorUserId, input.actorUserId));
      if (input.capability)
        conds.push(eq(schema.securityEvents.capability, input.capability));
      if (input.outcome)
        conds.push(eq(schema.securityEvents.outcome, input.outcome));
      if (fromDate) conds.push(gte(schema.securityEvents.occurredAt, fromDate));
      if (toDate) conds.push(lt(schema.securityEvents.occurredAt, toDate));

      const rows = await tx
        .select({
          eventType: schema.securityEvents.eventType,
          occurredAt: schema.securityEvents.occurredAt,
          actorUserId: schema.securityEvents.actorUserId,
          workspaceId: schema.securityEvents.workspaceId,
          capability: schema.securityEvents.capability,
          outcome: schema.securityEvents.outcome,
          requestId: schema.securityEvents.requestId,
        })
        .from(schema.securityEvents)
        .where(and(...conds))
        .orderBy(desc(schema.securityEvents.occurredAt))
        .limit(window);

      for (const r of rows) {
        events.push({
          source: "security",
          eventType: r.eventType,
          occurredAt: r.occurredAt.toISOString(),
          actorUserId: r.actorUserId,
          workspaceId: r.workspaceId,
          capability: r.capability,
          outcome: r.outcome,
          requestId: r.requestId,
        });
      }
    }
  });

  // Newest-first, then slice the requested page.
  events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const page = events.slice(input.offset, input.offset + input.limit);
  const hasMore = events.length > input.offset + input.limit;

  logger.info(
    { orgId, source: input.source, returned: page.length, hasMore },
    "audit.log.query: audit feed queried",
  );

  return {
    events: page,
    total: page.length,
    hasMore,
    limit: input.limit,
    offset: input.offset,
  };
};
