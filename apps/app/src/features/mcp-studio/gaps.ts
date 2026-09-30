// The work each Studio seam waits on (#4678, "Seams other lanes replace").
// An element with nothing behind it yet renders the not-recorded or not-built
// state and carries the issue as `data-gap`, so a reader of the DOM, and the
// audit, can follow it to the work that fills it. The page never prints the
// issue: a roadmap reference is not product copy.
const STUDIO_GAPS = {
  /**
   * The Studio record: the server's steering folder (tools.toml, the lock and
   * the tests) and the tools discovery found. Discovery is lane M10 (#4682,
   * PR #4711). Part 3 of this lane joins its tools to the folder, so the lane
   * issue carries the record.
   */
  record: 4678,
  /**
   * Adding a server the local gateway runs, by local command or as a
   * registry package. Review refuses a new local server with
   * `source_required`, because its draft carries no source and its folder has
   * no tools.lock.json yet, and only discovery, which needs the folder, can
   * list its tools (packages/handlers/src/mcp-studio/import/build.ts).
   */
  localCommand: 4756,
} as const;

export type StudioGap = keyof typeof STUDIO_GAPS;

/** The `data-gap` value an element carries: the issue that owns its work. */
export function studioGapRef(gap: StudioGap): string {
  return `#${String(STUDIO_GAPS[gap])}`;
}
