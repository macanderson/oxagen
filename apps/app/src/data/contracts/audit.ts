// The Audit view model (#3097; ARCHITECTURE.md §1.2, §3.3): one page of the
// organization's security audit events from query_audit_log, and the signed
// file export_audit_events answers. Fields are nullable exactly where the
// contract may not record them (INV-08). The page carries no raw database id
// (INV-11): the actor is a user's public id, the workspace its slug, and the
// request is the correlation token the calling surface minted. The event's own
// id is a database uuid with no public form, so it is not carried here; the
// export file has it as a column.
import { z } from "zod";
import { PublicId } from "./common";

/** `security.security_events.outcome` (its CHECK constraint). */
export const AuditOutcome = z.enum(["allow", "deny", "error", "success"]);
export type AuditOutcome = z.infer<typeof AuditOutcome>;

/** Events on one page of the record. */
export const AUDIT_PAGE_SIZE = 50;

/** The filters a reader sets in the URL, each null when unset; `from` and `to` are UTC days, both inclusive. */
export type AuditFilters = {
  eventType: string | null;
  outcome: AuditOutcome | null;
  actor: string | null;
  capability: string | null;
  from: string | null;
  to: string | null;
};

/** One page of the record: the filters plus where the page starts. */
export type AuditQuery = AuditFilters & { offset: number };

export type AuditExportFormat = "csv" | "ndjson";

/**
 * The filters as the audit port takes them: the reader's calendar days already
 * resolved to instants. A civil day is a pair of instants only once a zone is
 * known, and the zone is the viewer's preference — which `src/data/live/**` has
 * no way to ask for and no business knowing (ARCHITECTURE.md §2). So the feature
 * that resolved the viewer resolves the window too, and the port takes the
 * answer. The bounds are named apart from the day filters on purpose: the two
 * types are otherwise the same shape, and this way a day handed to the port
 * where an instant belongs does not compile.
 */
export type AuditWindow = Omit<AuditFilters, "from" | "to"> & {
  /** The first instant of the `from` day in the viewer's zone, inclusive; null when unset. */
  since: string | null;
  /** The first instant of the day after `to` in that zone, exclusive; null when unset. */
  until: string | null;
};

/** One page of the record, as the port takes it. */
export type AuditPageQuery = AuditWindow & { offset: number };

/** The signed export over the same window. */
export type AuditExportQuery = AuditWindow & { format: AuditExportFormat };

const AuditEvent = z.object({
  occurredAt: z.iso.datetime(),
  eventType: z.string().min(1),
  actor: PublicId.nullable(),
  capability: z.string().nullable(),
  // The contract records the outcome as a plain string, so the view narrows it
  // here: a value outside the CHECK constraint fails the parse and the adapter
  // reports record_unmappable rather than drawing an outcome nothing recorded.
  outcome: z.string().pipe(AuditOutcome).nullable(),
  workspace: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  request: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullish(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditPage = z.object({
  events: z.array(AuditEvent),
  hasMore: z.boolean(),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1),
});
export type AuditPage = z.infer<typeof AuditPage>;

export const AuditExport = z.object({
  format: z.enum(["csv", "ndjson"]),
  body: z.string(),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
  algorithm: z.literal("HMAC-SHA256"),
  rowCount: z.number().int().min(0),
});
export type AuditExport = z.infer<typeof AuditExport>;
