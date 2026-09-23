// The GitHub issues on macanderson/oxagen that track each Steering element
// with no backend yet (roadmap pages/steering.md, Backend gaps). An element
// renders NotBacked with its issue until the backend lands and the element
// comes off it; the number is printed so a reader can follow it.
export const STEERING_GAPS = {
  /** The registry port the assembler reads through: every source as one item type (Phase 1). */
  registry: 0,
  /** assembleSteering behind a read contract: Assignments and the Compiler. */
  assembler: 0,
  /** The gates that reach a workspace and the notice each puts into steering. */
  gates: 0,
} as const;
