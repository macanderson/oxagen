// audit-query.ts — the single read path for the audit-log viewer AND the
// signed export, so "what you see is what you export".
//
// Keyset pagination on (occurred_at DESC, id DESC) using the
// security_events_org_occurred_idx index. We over-fetch by one row to know
// whether a next page exists without a second COUNT.
//
// WHY withSystemDb AND NOT withTenantDb: this is an organization-level read of
// `security.security_events`, whose policy class is `workspace_nullable`
// (packages/database/src/tenant-policy.manifest.ts). Under the org-only
// workspace sentinel that policy's USING clause admits only the rows whose
// workspace_id IS NULL, so a tenant-scoped read here returned the org-wide
// events and silently dropped every workspace-scoped one — which is most of
// the security-relevant record: secret.reveal, plugin.credential.*,
// tacho.enrollment.*, and the kernel's own capability.invoke_allowed /
// capability.invoke_denied envelopes, all of which carry a real workspace.
// RLS hides rather than refuses, so nothing raised and the export below signed
// the short answer as a complete one. Tenant isolation is enforced HERE
// instead, explicitly: buildConditions() opens with eq(orgId) on every query
// and assertOrgFenced() re-checks the rows that come back. This is the same
// shape packages/handlers/src/audit.log.query.ts and iam.role.list.ts use over
// the same tables.

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
import { withSystemDb, schema } from "@oxagen/database";
import { logger } from "@oxagen/handlers/logger";
import type { AuditFilter } from "@/lib/audit-filters";
import { AUDIT_PAGE_SIZE } from "@/lib/audit-filters";

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

/**
 * The one thing this read path can check about its own answer. The org fence
 * is now a predicate in application code rather than a database policy, so a
 * regression in {@link buildConditions} would widen the read instead of
 * narrowing it, and a widened SOC 2 export leaks another tenant's record into
 * a signed file. Every returned row must carry the org that was asked for;
 * anything else throws before the caller can render or sign it.
 *
 * RLS could not raise on the truncation this replaced, which is why that bug
 * survived. This one can.
 */
export function assertOrgFenced(
  rows: readonly { orgId: string }[],
  orgId: string,
): void {
  const foreign = rows.find((r) => r.orgId !== orgId);
  if (foreign) {
    logger.error(
      { orgId, foreignOrgId: foreign.orgId },
      "audit-query: org fence returned a foreign row; refusing the page",
    );
    throw new Error(
      "audit-query: org fence violated — a row outside the requested org was returned",
    );
  }
}

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
  const rows = await withSystemDb((tx) =>
    tx
      .select(COLUMNS)
      .from(schema.securityEvents)
      .where(and(...conds))
      .orderBy(
        desc(schema.securityEvents.occurredAt),
        desc(schema.securityEvents.id),
      )
      .limit(pageSize + 1),
  );
  assertOrgFenced(rows, orgId);

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
 *
 * `maxRows` is the same hazard in a second form: an org whose record is longer
 * than the cap used to get a signed file holding the newest `maxRows` events
 * and no indication that older ones exist. That file is a complete-but-short
 * export by a different route, so reaching the cap with a page still to come
 * throws too. Narrow the filter (a date range) to export a longer record.
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
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
  logger.error(
    { orgId, maxRows },
    "queryAuditForExport: the record is longer than maxRows; refusing to sign a truncated export",
  );
  throw new Error(
    `Audit export exceeds ${maxRows} events. Narrow the filter (for example a date range) and export again; a truncated export must not be signed.`,
  );
}
