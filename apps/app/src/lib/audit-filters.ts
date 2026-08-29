// audit-filters.ts — pure parsing / encoding of the audit-log viewer filter
// state. No DB, no React — node-testable. The viewer page, the filter bar, and
// the signed-export endpoint all share this so the rows you see are exactly the
// rows you export.

import {
  SECURITY_EVENT_TYPES,
  SECURITY_OUTCOMES,
  isSecurityEventType,
  isSecurityOutcome,
} from "@oxagen/compliance";
import type { SecurityEventType, SecurityOutcome } from "@oxagen/compliance";

export const AUDIT_PAGE_SIZE = 100;

export interface AuditFilter {
  /** Empty = all event types. */
  eventTypes: SecurityEventType[];
  outcome: SecurityOutcome | null;
  /** Exact actor user id (uuid). */
  actorUserId: string | null;
  /** Free-text contains-match over capability / ip / request_id. */
  q: string | null;
  from: Date | null;
  to: Date | null;
  /** Keyset cursor: "<occurredAtISO>|<id>" of the last row of the prior page. */
  cursor: { occurredAt: Date; id: string } | null;
}

/** A plain record of the searchParams we read (Next passes string | string[]). */
export type RawSearchParams = Record<string, string | string[] | undefined>;

function firstString(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function parseDate(v: string | null): Date | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Parse raw Next.js searchParams into a validated AuditFilter. Unknown event
 * types / outcomes are dropped rather than throwing — a tampered URL degrades
 * to "no filter" instead of erroring.
 */
export function parseAuditFilter(sp: RawSearchParams): AuditFilter {
  // event_type may repeat (?event_type=a&event_type=b) or be comma-joined.
  const rawTypes: string[] = [];
  const et = sp["event_type"];
  if (Array.isArray(et)) rawTypes.push(...et);
  else if (typeof et === "string") rawTypes.push(...et.split(","));

  const eventTypes = rawTypes
    .map((s) => s.trim())
    .filter((s): s is SecurityEventType => isSecurityEventType(s));

  const outcomeRaw = firstString(sp["outcome"]);
  const outcome =
    outcomeRaw && isSecurityOutcome(outcomeRaw) ? outcomeRaw : null;

  const actorUserId = firstString(sp["actor"]);
  const q = firstString(sp["q"]);

  let cursor: AuditFilter["cursor"] = null;
  const rawCursor = firstString(sp["cursor"]);
  if (rawCursor) {
    const sep = rawCursor.lastIndexOf("|");
    if (sep > 0) {
      const occurredAt = parseDate(rawCursor.slice(0, sep));
      const id = rawCursor.slice(sep + 1);
      if (occurredAt && id) cursor = { occurredAt, id };
    }
  }

  return {
    eventTypes: Array.from(new Set(eventTypes)),
    outcome,
    actorUserId: actorUserId && actorUserId.length > 0 ? actorUserId : null,
    q: q && q.trim().length > 0 ? q.trim() : null,
    from: parseDate(firstString(sp["from"])),
    to: parseDate(firstString(sp["to"])),
    cursor,
  };
}

/** Encode a filter back to a URLSearchParams (cursor optionally overridden). */
export function encodeAuditFilter(
  f: AuditFilter,
  opts: { cursor?: { occurredAt: Date; id: string } | null } = {},
): URLSearchParams {
  const sp = new URLSearchParams();
  for (const t of f.eventTypes) sp.append("event_type", t);
  if (f.outcome) sp.set("outcome", f.outcome);
  if (f.actorUserId) sp.set("actor", f.actorUserId);
  if (f.q) sp.set("q", f.q);
  if (f.from) sp.set("from", f.from.toISOString());
  if (f.to) sp.set("to", f.to.toISOString());
  const cursor = "cursor" in opts ? opts.cursor : f.cursor;
  if (cursor)
    sp.set("cursor", `${cursor.occurredAt.toISOString()}|${cursor.id}`);
  return sp;
}

/** Build a cursor token from a row (for the "next page" link). */
export function cursorOf(row: { occurredAt: Date; id: string }): {
  occurredAt: Date;
  id: string;
} {
  return { occurredAt: row.occurredAt, id: row.id };
}

/** True when any user-facing filter is active (used to show a "clear" affordance). */
export function hasActiveFilter(f: AuditFilter): boolean {
  return (
    f.eventTypes.length > 0 ||
    f.outcome !== null ||
    f.actorUserId !== null ||
    f.q !== null ||
    f.from !== null ||
    f.to !== null
  );
}

/** The set of event-type "group" prefixes, for the quick-filter chips. */
export const EVENT_TYPE_GROUPS = Array.from(
  new Set(SECURITY_EVENT_TYPES.map((t) => t.split(".")[0]!)),
);

/** All event types in a group prefix (e.g. "auth" → auth.*). */
export function eventTypesInGroup(group: string): SecurityEventType[] {
  return SECURITY_EVENT_TYPES.filter((t) => t.startsWith(`${group}.`));
}

export { SECURITY_EVENT_TYPES, SECURITY_OUTCOMES };
