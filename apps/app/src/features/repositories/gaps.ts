// The backend gaps this page names where it renders them (mockups/pages/
// repositories.md, "Backend gaps this page depends on"). An element with no
// store behind it prints as not recorded and carries its issue as `data-gap`.
// A gap leaves this table in the pull request that backs it.
export const REPOSITORY_GAPS = {
  /**
   * #3241 carries the lifecycle this page assumes: working copies, the
   * pull-request kinds beyond context records, the close comment, the
   * reconciler and drift, the code graph and event counters, and
   * `set_main_repository`.
   */
  lifecycle: "#3241",
  /** A person refused a page asking for the role it needs. */
  requestAccess: "#3820",
  /** An error state opening an incident, and the trace it names. */
  incident: "#3847",
} as const;
