// Which record the route names (#3395), and where the page links back to. A
// lineage is a file stem under `.oxagen/rules/`, so it reaches this page from
// the repository rather than from us: it is checked against the contract's own
// rule here, and an address that could never name a record is a 404 rather
// than a page error.
import { routes, type SafePath } from "@/shared/safe-path";

/** The workspace a link on the page points into, and the record it is about. */
export type RecordAt = { org: string; ws: string; lineage: string };

/**
 * `context.steering.shared`'s lineage rule, repeated here so a wrong address
 * is answered before a read is made. Lowercase letters, digits, dots and
 * hyphens, starting and ending on a letter or a digit, up to 200 characters.
 */
export const LINEAGE = /^[a-z0-9][a-z0-9.-]{0,198}[a-z0-9]$|^[a-z0-9]$/;

/** This page's own address, for a retry link and for a write to return to. */
export function recordLink(at: RecordAt): SafePath {
  return routes.steeringRecord(at.org, at.ws, at.lineage);
}
