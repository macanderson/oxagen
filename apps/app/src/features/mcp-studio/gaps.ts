// The work each Studio seam waits on (#4678, "Seams other lanes replace").
// An element with nothing behind it yet renders the not-recorded or not-built
// state and carries the issue as `data-gap`, so a reader of the DOM, and the
// audit, can follow it to the work that fills it. The page never prints the
// issue: a roadmap reference is not product copy.
const STUDIO_GAPS = {
  /**
   * The Studio record: the server's steering folder (tools.toml, the lock and
   * the tests) and the tools discovery found. Discovery is lane M10 (#4682,
   * PR #4711). PR2 of this lane joins its tools to the folder, so the lane
   * issue carries the record.
   */
  record: 4678,
  /**
   * Discovery progress and the tools discovery found: lane M10 part 2
   * (start_studio_discovery, get_studio_discovery, list_studio_tools).
   */
  discovery: 4682,
  /** Try it and Draft: try_studio_tool and draft_studio_description. */
  capability: 4742,
  /** Saving the draft and opening a steering PR from it: lane M11 (PR #4688). */
  steeringPr: 4686,
  /** Findings on the draft: list_studio_findings, which runs lane M5's lint. */
  findings: 4742,
  /** Writing a named credential: set_mcp_credential. */
  credentials: 4742,
} as const;

export type StudioGap = keyof typeof STUDIO_GAPS;

/** The `data-gap` value an element carries: the issue that owns its work. */
export function studioGapRef(gap: StudioGap): string {
  return `#${String(STUDIO_GAPS[gap])}`;
}
