import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  auditLogQuery,
  type AuditEvent,
} from "@oxagen/oxagen/contracts/audit.log.query";
import { schema, withSystemDb } from "@oxagen/database";
import { and, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { logger } from "./logger";

/**
 * audit.log.query handler.
 *
 * Reads the append-only audit spine and returns a newest-first feed. The table
 * is read through withSystemDb (security_events is partitioned and lives in a
 * bypass-only schema), so tenant isolation is enforced HERE, explicitly: EVERY
 * query filters by ctx.orgId. Never relax this — a missing org filter would leak
 * another tenant's audit trail (SOC 2 §0).
 *
 * Workspace narrowing comes ONLY from `input.workspaceId`; ctx.workspaceId is
 * deliberately not applied, so the default result is the whole org's feed. That
 * is what the org Governance hub wants, but it also means a caller allowed at
 * workspace scope reads events from sibling workspaces — see the contract's
 * defaultRoles before widening who may invoke this.
 *
 * Pagination is done by over-fetching (offset+limit+1), ordering by occurredAt
 * desc, then slicing the window. Correct and bounded for the realistic admin
 * use case.
 */
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
    if (wantSecurity) {
      const conds: SQL[] = [eq(schema.securityEvents.orgId, orgId)];
      if (input.workspaceId)
        conds.push(eq(schema.securityEvents.workspaceId, input.workspaceId));
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
