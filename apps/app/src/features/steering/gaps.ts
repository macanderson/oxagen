// The GitHub issues on macanderson/oxagen that track each Steering element
// with no backend yet (roadmap pages/steering.md, Backend gaps). An element
// renders NotBacked with its issue until the backend lands and the element
// comes off it; the number is printed so a reader can follow it.
export const STEERING_GAPS = {
  /** One read of every source as one item type, with token cost and grant (#3830, after Phase 1, #3296). */
  registry: 3830,
  /** assembleSteering behind a read-only capability for one agent and one prompt: the Compiler and Assignments (#3879). */
  assembler: 3879,
  /** The gates that reach a workspace and the notice each puts into steering (#3880). */
  gates: 3880,
  /** The outcome, citing frame and record of each run a proposal cites, and the promoter's confidence (#3881). */
  support: 3881,
  /** A Context PR's record file, code owner, closing comment and promotion event, read from GitHub (#3882). */
  contextPr: 3882,
  /** A governance change as a Context PR in every mode, and an org-owner approval and security event for a lowering (#3859). */
  governance: 3859,
  /** The policy that decided a refused read, carried on the denial (#3846). */
  denial: 3846,
} as const;
