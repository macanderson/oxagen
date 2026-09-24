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
import { Money } from "./money";

/** `security.security_events.outcome` (its CHECK constraint). */
export const AuditOutcome = z.enum(["allow", "deny", "error", "success"]);
export type AuditOutcome = z.infer<typeof AuditOutcome>;

/**
 * The Rows select: how many events one page of the table shows (rev1 audit.md,
 * Events). The design also offers All, which this page leaves out: one read
 * returns at most AUDIT_TILE_LIMIT events, so "All" would be a claim the read
 * cannot keep past that many.
 */
export const AUDIT_ROWS = [5, 10, 25, 50] as const;
export type AuditRows = (typeof AUDIT_ROWS)[number];
/** Rows on a page when the URL names none; the design opens on ten. */
export const AUDIT_DEFAULT_ROWS: AuditRows = 10;

/**
 * The Range select: how far back the record is read, ending now. The design
 * opens the page on thirty days, which is the window the first tile names.
 */
export const AUDIT_RANGES = ["48h", "7d", "30d"] as const;
export type AuditRange = (typeof AUDIT_RANGES)[number];
export const AUDIT_DEFAULT_RANGE: AuditRange = "30d";

/**
 * The most events the summary tiles count in one read: the contract's own
 * page limit. A window holding more shows its counts as a lower bound.
 */
export const AUDIT_TILE_LIMIT = 200;

/**
 * The filters a reader sets in the URL, each null when unset. `range` is the
 * window ending now; `from` and `to` are calendar days, both inclusive, and
 * replace the range when either is set (a link from before the Range select).
 */
export type AuditFilters = {
  eventType: string | null;
  outcome: AuditOutcome | null;
  actor: string | null;
  capability: string | null;
  range: AuditRange;
  from: string | null;
  to: string | null;
};

/** One page of the record: the filters, the page size and where the page starts. */
export type AuditQuery = AuditFilters & { rows: AuditRows; offset: number };

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
export type AuditWindow = Omit<AuditFilters, "from" | "to" | "range"> & {
  /** The first instant of the `from` day in the viewer's zone, inclusive; null when unset. */
  since: string | null;
  /** The first instant of the day after `to` in that zone, exclusive; null when unset. */
  until: string | null;
};

/** One page of the record, as the port takes it: at most `limit` events from `offset`. */
export type AuditPageQuery = AuditWindow & { offset: number; limit: number };

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

/**
 * The organization's evidence retention posture from get_evidence_retention
 * (ADR-052 §4.3), as Audit's header and Retention tab print it. The body
 * retention is the longest window a pinned retention policy declares, null
 * when none is pinned. The stored volume is null until the accounting job has
 * measured it: a null is "not measured", never "nothing stored".
 */
export const AuditRetention = z.object({
  includedMonths: z.number().int().positive(),
  bodyRetentionDays: z.number().int().positive().nullable(),
  /** The per-GB-month rate past the included months; null when it is not a decimal the money parser takes. */
  rate: Money.nullable(),
  storedGbBeyondIncluded: z.number().nonnegative().nullable(),
});
export type AuditRetention = z.infer<typeof AuditRetention>;

/** Where a queued export has got to (`get_export_status`). */
export const AuditBundleStatus = z.enum([
  "queued",
  "processing",
  "ready",
  "failed",
]);

/**
 * One organization export Build bundle queued (export_data, scope org), read
 * back by its id. The archive is the organization's data export as a ZIP; the
 * signed segment bundle the design describes has no store yet (#3876), so its
 * range, size, signature and key ids are not part of this record.
 */
export const AuditBundle = z.object({
  exportId: z.uuid(),
  status: AuditBundleStatus,
  ready: z.boolean(),
  completedAt: z.string().nullable(),
});
export type AuditBundle = z.infer<typeof AuditBundle>;
