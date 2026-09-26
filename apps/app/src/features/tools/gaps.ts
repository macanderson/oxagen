// The backend gaps the Tools page states rather than fills (mockup `tools.md`,
// "Backend gaps this page depends on"). Each element with no store behind it
// renders the not-recorded state and carries the GitHub issue that owns the
// store as `data-gap`, so a reader of the DOM, and the audit, can follow the
// element to the work that backs it. The page never prints the issue: a
// roadmap reference is not product copy.
const TOOLS_GAPS = {
  /**
   * The belts holding each tool version and the agents carrying them, per row
   * of the registry. Toolbelts are stored now (ADR-198) and the Toolbelts tab
   * reads them, but no read answers belt membership per tool version.
   */
  toolbelts: 3852,
  /** A provider's system, transport and wire apart from the MCP server row, and editing one. */
  providers: 3917,
  /** Client registration, code exchange, refresh, expiry and review dates on a connection. */
  oauth: 3918,
  /** G2: policy versions with their tests, drafted, activated and restored. */
  policy: 3920,
  /** A tool's category, and output schemas observed rather than declared. */
  registry: 3921,
  /** Class switches by side effect and egress, device scope, and editing a switch. */
  switches: 3922,
  /** The tool version and agent behind each credential grant. */
  grants: 3923,
  /** The tool creation wizard: describe, recommend, manifest or import, code, pull request. */
  toolWizard: 3924,
  /** A person refused a page asks for the role from the page. */
  requestAccess: 3820,
  /** A failed page opens an incident and names its trace. */
  incident: 3847,
} as const;

export type ToolsGap = keyof typeof TOOLS_GAPS;

/** The `data-gap` value an element carries: the issue that owns its store. */
export function gapRef(gap: ToolsGap): string {
  return `#${String(TOOLS_GAPS[gap])}`;
}
