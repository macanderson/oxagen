// The backend gaps this page names where it renders them (mockups/pages/
// record.md, "Backend gaps this page depends on"). Each element with no store
// behind it prints as not recorded and carries its issue here as `data-gap`,
// so the row that owns the fix is one lookup from the element that waits on
// it. A gap leaves this table in the pull request that backs it.
export const RECORD_GAPS = {
  /** `archive_context_record`: the pull request that takes a record out of force. */
  archive: "#3867",
  /** The rollup of runs that went against, crossed or departed from a record. */
  violated: "#3868",
  /** The record's token share of the compiled bundle, and its enforcement grant. */
  bundle: "#3830",
  /** A person refused a page asking for the role it needs. */
  requestAccess: "#3820",
  /** An error state opening an incident, and the trace it names. */
  incident: "#3847",
} as const;
