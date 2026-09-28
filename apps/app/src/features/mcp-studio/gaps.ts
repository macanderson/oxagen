// The work each Studio seam waits on (#4678, "Seams other lanes replace").
// An element with nothing behind it yet renders the not-recorded or not-built
// state and carries the issue as `data-gap`, so a reader of the DOM, and the
// audit, can follow it to the work that fills it. The page never prints the
// issue: a roadmap reference is not product copy.
const STUDIO_GAPS = {
  /**
   * The Studio record: the server's steering folder (tools.toml, the lock and
   * the tests) and the tools discovery found. Discovery is lane M10, which has
   * no issue of its own yet, so the lane issue carries it.
   */
  record: 4678,
  /** Try it and Draft run through capabilities that PR2 of this lane adds. */
  capability: 4678,
  /** Opening a steering PR from the Studio draft: lane M11, not started. */
  steeringPr: 4678,
  /** Findings on the draft: lane M5's lint. */
  findings: 4672,
  /** Writing a credential: lane M8. */
  credentials: 4668,
} as const;

export type StudioGap = keyof typeof STUDIO_GAPS;

/** The `data-gap` value an element carries: the issue that owns its work. */
export function studioGapRef(gap: StudioGap): string {
  return `#${String(STUDIO_GAPS[gap])}`;
}
