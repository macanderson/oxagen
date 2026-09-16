// Which page of the audit record a request asks for (#3097): the filters and
// the offset, read from the query string. A filter is a query value rather
// than a route (ARCHITECTURE.md §1.2), and a value the record cannot hold is
// dropped rather than sent to the contract, so a hand-edited URL opens the
// newest page instead of an error.
//
// The event types offered are the ones something in the platform writes
// (`EMITTED_SECURITY_EVENT_TYPES`, #2528), so the filter never lists a value no
// row can carry. `@oxagen/compliance` is a leaf package with no store and no
// kernel; §2's layer matrix admits it for this file alone.
import { EMITTED_SECURITY_EVENT_TYPES } from "@oxagen/compliance";
import {
  AUDIT_PAGE_SIZE,
  type AuditExportFormat,
  type AuditFilters,
  AuditOutcome,
  type AuditQuery,
} from "@/data/contracts/audit";
import { firstParam } from "@/shared/safe-path";

/** The event types the filter offers, in the order the platform declares them. */
export const AUDIT_EVENT_TYPES: readonly string[] =
  EMITTED_SECURITY_EVENT_TYPES;

/** The outcomes the filter offers (the column's CHECK constraint). */
export const AUDIT_OUTCOMES = AuditOutcome.options;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * The largest offset the page hands the contract. The record is paged, not
 * scrolled, and PostgreSQL takes OFFSET as a bigint: a hand-edited
 * `?offset=1e21` is finite and positive, so a bare `Number` check would send
 * it on and the store would fail the conversion where the URL is what is
 * wrong. Well past any page a reader reaches, and inside a safe integer.
 */
const MAX_OFFSET = 1_000_000;
/** A capability name (ADR-025 verb-first snake_case, and the dotted names still registered). */
const CAPABILITY = /^[a-z][a-z0-9_.]{0,63}$/;
/** An actor is a user's public id; the contract matches on `usr_…` and nothing else. */
const ACTOR = /^usr_[A-Za-z0-9]+$/;

type Params = Readonly<Record<string, string | string[] | undefined>>;

function value(params: Params, key: string, ok: (raw: string) => boolean) {
  const raw = firstParam(params[key]);
  return raw !== undefined && ok(raw) ? raw : null;
}

/**
 * A calendar day, or null. The shape is not enough: `2026-99-99` matches the
 * regex and makes an Invalid Date, and `2026-02-31` silently becomes 3 March,
 * so the value has to round-trip through UTC as the same day it claims to be.
 */
function isDay(raw: string): boolean {
  if (!DAY.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(raw)
  );
}

/** A calendar day the reader typed, or null; `from` after `to` is not a range, so both go. */
function range(params: Params): Pick<AuditFilters, "from" | "to"> {
  const from = value(params, "from", isDay);
  const to = value(params, "to", isDay);
  if (from !== null && to !== null && from > to)
    return { from: null, to: null };
  return { from, to };
}

/** Where the page starts: a whole number of events, rounded down to a page boundary. */
function offsetOf(params: Params): number {
  const raw = Number(firstParam(params.offset));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return (
    Math.floor(Math.min(raw, MAX_OFFSET) / AUDIT_PAGE_SIZE) * AUDIT_PAGE_SIZE
  );
}

export function parseAuditQuery(params: Params): AuditQuery {
  const outcome = value(params, "outcome", (raw) =>
    AUDIT_OUTCOMES.some((option) => option === raw),
  );
  return {
    eventType: value(params, "eventType", (raw) =>
      AUDIT_EVENT_TYPES.includes(raw),
    ),
    outcome: outcome === null ? null : AuditOutcome.parse(outcome),
    actor: value(params, "actor", (raw) => ACTOR.test(raw)),
    capability: value(params, "capability", (raw) => CAPABILITY.test(raw)),
    ...range(params),
    offset: offsetOf(params),
  };
}

/** Whether any filter is set, which is what tells an empty record from an empty answer. */
export function hasAuditFilters(query: AuditQuery): boolean {
  const { offset: _offset, ...filters } = query;
  return Object.values(filters).some((filter) => filter !== null);
}

/** The query values a link carries: every set filter, and an offset past the first page. */
export function auditQueryParams(
  query: AuditQuery,
  over: { offset?: number; format?: AuditExportFormat } = {},
): Record<string, string | undefined> {
  const offset = over.offset ?? query.offset;
  return {
    eventType: query.eventType ?? undefined,
    outcome: query.outcome ?? undefined,
    actor: query.actor ?? undefined,
    capability: query.capability ?? undefined,
    from: query.from ?? undefined,
    to: query.to ?? undefined,
    offset: offset > 0 ? String(offset) : undefined,
    format: over.format,
  };
}

/** The export format a request named, CSV when it named none the contract knows. */
export function parseAuditExportFormat(
  params: Params,
): AuditExportFormat | null {
  const raw = firstParam(params.format);
  if (raw === "csv" || raw === "ndjson") return raw;
  return null;
}
