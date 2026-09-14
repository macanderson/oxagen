// audit-query.ts — the single tenant-scoped read path for the audit-log viewer
// AND the signed export, so "what you see is what you export".
//
// Keyset pagination on (occurred_at DESC, id DESC) using the
// security_events_org_occurred_idx index. We over-fetch by one row to know
// whether a next page exists without a second COUNT.

import {
  and,
  eq,
  lt,
  gte,
  lte,
  or,
  ilike,
  desc,
  inArray,
  type SQL,
} from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";
import type { AuditFilter } from "@/lib/audit-filters";
import { AUDIT_PAGE_SIZE } from "@/lib/audit-filters";

// Org-only route — sentinel workspaceId.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export interface AuditEventRow {
  id: string;
  occurredAt: Date;
  eventType: string;
  outcome: string;
  actorUserId: string | null;
  orgId: string;
  workspaceId: string | null;
  capability: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

function buildConditions(orgId: string, f: AuditFilter): SQL[] {
  const se = schema.securityEvents;
  const conds: SQL[] = [eq(se.orgId, orgId)];

  if (f.eventTypes.length > 0) conds.push(inArray(se.eventType, f.eventTypes));
  if (f.outcome) conds.push(eq(se.outcome, f.outcome));
  if (f.actorUserId) conds.push(eq(se.actorUserId, f.actorUserId));
  if (f.from) conds.push(gte(se.occurredAt, f.from));
  if (f.to) conds.push(lte(se.occurredAt, f.to));

  if (f.q) {
    const needle = `%${f.q}%`;
    const textMatch = or(
      ilike(se.capability, needle),
      ilike(se.ip, needle),
      ilike(se.requestId, needle),
      ilike(se.userAgent, needle),
    );
    if (textMatch) conds.push(textMatch);
  }

  if (f.cursor) {
    // Keyset: strictly "older" than the cursor in (occurredAt, id) order.
    const keyset = or(
      lt(se.occurredAt, f.cursor.occurredAt),
      and(eq(se.occurredAt, f.cursor.occurredAt), lt(se.id, f.cursor.id)),
    );
    if (keyset) conds.push(keyset);
  }

  return conds;
}

const COLUMNS = {
  id: schema.securityEvents.id,
  occurredAt: schema.securityEvents.occurredAt,
  eventType: schema.securityEvents.eventType,
  outcome: schema.securityEvents.outcome,
  actorUserId: schema.securityEvents.actorUserId,
  orgId: schema.securityEvents.orgId,
  workspaceId: schema.securityEvents.workspaceId,
  capability: schema.securityEvents.capability,
  ip: schema.securityEvents.ip,
  userAgent: schema.securityEvents.userAgent,
  requestId: schema.securityEvents.requestId,
} as const;

export interface AuditPage {
  rows: AuditEventRow[];
  nextCursor: { occurredAt: Date; id: string } | null;
}

/**
 * Core keyset page fetch. Throws on any DB/RLS error — the caller decides
 * whether to swallow (viewer) or propagate (export). Kept private so the two
 * public entry points can apply different failure policies without duplicating
 * the query.
 */
async function fetchAuditPage(
  orgId: string,
  filter: AuditFilter,
  pageSize: number,
): Promise<AuditPage> {
  const conds = buildConditions(orgId, filter);
  const rows = await runInTenantScope({ orgId, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) =>
      tx
        .select(COLUMNS)
        .from(schema.securityEvents)
        .where(and(...conds))
        .orderBy(
          desc(schema.securityEvents.occurredAt),
          desc(schema.securityEvents.id),
        )
        .limit(pageSize + 1),
    ),
  );

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor:
      hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null,
  };
}

/**
 * Fetch one page of audit events for the VIEWER. Returns up to `pageSize` rows
 * plus a `nextCursor` when more exist.
 *
 * A DB/RLS error is logged and degraded to an empty page so the viewer renders
 * without crashing. This swallow is SAFE here because an empty viewer page is
 * not interpreted as a complete dataset — it must NOT be used by the export
 * path, where an empty page is indistinguishable from end-of-results and would
 * silently truncate a signed compliance export. The export path uses
 * {@link queryAuditForExport}, which propagates the error instead.
 */
export async function queryAuditPage(
  orgId: string,
  filter: AuditFilter,
  pageSize = AUDIT_PAGE_SIZE,
): Promise<AuditPage> {
  try {
    return await fetchAuditPage(orgId, filter, pageSize);
  } catch (err) {
    logger.error({ err, orgId }, "queryAuditPage failed");
    return { rows: [], nextCursor: null };
  }
}

/**
 * Stream-ish bulk fetch for export: walks keyset pages up to `maxRows` so a
 * full evidence export does not load an unbounded result set into memory.
 *
 * Unlike the viewer path, this PROPAGATES any DB/RLS error rather than
 * swallowing it. A mid-export failure that returned an empty page would be
 * structurally identical to a legitimate end-of-results response, so the loop
 * would break early and the export route would HMAC-sign a silently truncated
 * (possibly empty) dataset — an undetectable gap in the SOC 2 evidence chain.
 * By throwing, the export route returns a non-200 and never emits a partial
 * file that looks complete.
 */
export async function queryAuditForExport(
  orgId: string,
  filter: AuditFilter,
  maxRows = 50_000,
): Promise<AuditEventRow[]> {
  const out: AuditEventRow[] = [];
  let cursor = filter.cursor;
  while (out.length < maxRows) {
    const remaining = maxRows - out.length;
    const pageSize = Math.min(AUDIT_PAGE_SIZE, remaining);
    // fetchAuditPage (not queryAuditPage) — propagate errors so a DB failure
    // cannot masquerade as a complete-but-short export.
    const page = await fetchAuditPage(orgId, { ...filter, cursor }, pageSize);
    out.push(...page.rows);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}
