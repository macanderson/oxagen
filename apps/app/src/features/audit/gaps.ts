// The GitHub issue each unbacked part of the Audit page waits on
// (macanderson/oxagen). A page element with no store behind it renders one
// sentence saying what is missing and carries its issue as `data-issue`, so a
// reviewer can find the backend change from the DOM. The number never reaches
// the reader's text: a customer is told what is missing, not where it is filed.
export const AUDIT_GAPS = {
  /** Severity, actor kind, a text search and a total on the audit read. */
  events: { issue: "TBD_EVENTS" },
  /** The organization's incidents, their kinds and the open, assign and resolve writes. */
  incidents: { issue: "TBD_INCIDENTS" },
  /** One signed receipt per tool call. */
  receipts: { issue: "TBD_RECEIPTS" },
  /** Evidence bundles, the verifier and outbound events. */
  exports: { issue: "TBD_EXPORTS" },
  /** The organization's key-encryption key and its rotation. */
  keys: { issue: "TBD_KEYS" },
  /** The retention policy, its archive tiers and its edit. */
  retention: { issue: "TBD_RETENTION" },
  /** A person refused a page asks for the role it needs (#3820). */
  requestAccess: { issue: "3820" },
  /** A page that fails to load opens an incident and names its trace (#3847). */
  errorIncident: { issue: "3847" },
} as const;
