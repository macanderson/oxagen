// Audit's six tabs (rev1 audit.md, Tabs), each a URL segment under the page
// (ARCHITECTURE.md §1.2): Events is the page's own route, and the other five
// are `/{org}/audit/<tab>`. A segment outside this list is a 404, not a
// fallback to Events, so a mistyped link says so.
export const AUDIT_TABS = [
  "events",
  "incidents",
  "receipts",
  "exports",
  "keys",
  "retention",
] as const;

export type AuditTab = (typeof AUDIT_TABS)[number];

/** The tabs that are segments of their own: every tab but Events. */
type AuditSegmentTab = Exclude<AuditTab, "events">;

/** The tab a route segment names, or null when it names none. */
export function auditTabOf(segment: string): AuditSegmentTab | null {
  for (const tab of AUDIT_TABS) {
    if (tab !== "events" && tab === segment) return tab;
  }
  return null;
}
