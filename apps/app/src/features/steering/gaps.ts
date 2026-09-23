// The GitHub issues on macanderson/oxagen that track each Steering element
// with no backend yet (roadmap pages/steering.md, Backend gaps). An element
// renders NotBacked with its issue until the backend lands and the element
// comes off it; the number is printed so a reader can follow it.
export const STEERING_GAPS = {
  /** One read of every source as one item type, with token cost and grant (#3830, after Phase 1, #3296). */
  registry: 3830,
  /** assembleSteering behind a read-only capability: the Compiler and Assignments (#3297 item 4). */
  assembler: 3297,
  /** The gates that reach a workspace and the notice each puts into steering (#3297 item 3). */
  gates: 3297,
} as const;
