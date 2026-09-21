// audit.shared.ts — the security_events read `query_audit_log` and
// `export_audit_events` share, so the rows a reader pages through are the rows
// an export signs.
//
// The read goes through withSystemDb, so RLS is off for it and tenant
// isolation is enforced HERE: every query filters by the caller's orgId, and
// the workspace join is fenced to the same org. A missing org filter would
// leak another tenant's audit trail (SOC 2 §0).
//
// Rows come newest first on (occurred_at DESC, id DESC). The keyset cursor
// carries occurred_at as Postgres renders it, microseconds included: a JS Date
// holds milliseconds, and a cursor rounded to them would skip every row that
// shares the millisecond of a page's last row.
import type { AuditEvent } from "@oxagen/oxagen/contracts/audit.log.query";
import { schema, type Tx } from "@oxagen/database";
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";

/**
 * The workspace id an organization-level invoke carries (apps/app
 * `src/server/kernel.ts`, `apps/api/src/routes/v1/audit.events.export.ts`). It
 * names no workspace, so a call carrying it is treated as having no workspace
 * scope. Declared with the contracts, so a surface and a handler cannot drift
 * to two different sentinels.
 */
export { ORG_ONLY_WORKSPACE_ID as ORG_ONLY_WS } from "@oxagen/oxagen/contracts/audit.log.query";

/** The filters both audit contracts accept. */
export type AuditEventFilter = {
  eventType?: string;
  actorUserId?: string;
  actorPublicId?: string;
  capability?: string;
  outcome?: string;
  from?: string;
  to?: string;
};

/** Where a keyset page ended: the last row's occurred_at text and id. */
export type AuditCursor = { at: string; id: string };

const se = schema.securityEvents;

/** The WHERE clause: the org always, the workspace when one is given, then each filter. */
export function auditConditions(
  orgId: string,
  workspaceId: string | null,
  f: AuditEventFilter,
): SQL[] {
  const conds: SQL[] = [eq(se.orgId, orgId)];
  if (workspaceId !== null) conds.push(eq(se.workspaceId, workspaceId));
  if (f.eventType) conds.push(eq(se.eventType, f.eventType));
  if (f.actorUserId) conds.push(eq(se.actorUserId, f.actorUserId));
  if (f.actorPublicId) conds.push(eq(schema.users.publicId, f.actorPublicId));
  if (f.capability) conds.push(eq(se.capability, f.capability));
  if (f.outcome) conds.push(eq(se.outcome, f.outcome));
  if (f.from) conds.push(gte(se.occurredAt, new Date(f.from)));
  if (f.to) conds.push(lt(se.occurredAt, new Date(f.to)));
  return conds;
}

/** Strictly older than the cursor in (occurred_at, id) order. */
export function afterCursor(cursor: AuditCursor): SQL {
  return sql`(${se.occurredAt}, ${se.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`;
}

export type AuditRow = { event: AuditEvent; cursor: AuditCursor };

/** One page of events matching `where`, newest first, `offset` rows in. */
export async function readAuditEvents(
  tx: Tx,
  where: SQL[],
  page: { limit: number; offset: number },
): Promise<AuditRow[]> {
  const rows = await tx
    .select({
      id: se.id,
      at: sql<string>`${se.occurredAt}::text`,
      occurredAt: se.occurredAt,
      eventType: se.eventType,
      actorUserId: se.actorUserId,
      actorPublicId: schema.users.publicId,
      workspaceId: se.workspaceId,
      workspaceSlug: schema.workspaces.slug,
      capability: se.capability,
      outcome: se.outcome,
      ip: se.ip,
      userAgent: se.userAgent,
      requestId: se.requestId,
      detail: se.detail,
    })
    .from(se)
    .leftJoin(schema.users, eq(schema.users.id, se.actorUserId))
    .leftJoin(
      schema.workspaces,
      and(
        eq(schema.workspaces.id, se.workspaceId),
        eq(schema.workspaces.orgId, se.orgId),
      ),
    )
    .where(and(...where))
    .orderBy(desc(se.occurredAt), desc(se.id))
    .limit(page.limit)
    .offset(page.offset);

  return rows.map((r) => ({
    event: {
      id: r.id,
      source: "security",
      eventType: r.eventType,
      occurredAt: r.occurredAt.toISOString(),
      actorUserId: r.actorUserId,
      actorPublicId: r.actorPublicId,
      workspaceId: r.workspaceId,
      workspaceSlug: r.workspaceSlug,
      capability: r.capability,
      outcome: r.outcome,
      ip: r.ip,
      userAgent: r.userAgent,
      requestId: r.requestId,
      detail: r.detail == null ? null : { ...r.detail },
    },
    cursor: { at: r.at, id: r.id },
  }));
}
