// The three commands a run's row on Fleet sends: pause, resume and cancel.
// Steer is not among them, because `dispatch_command` requires a payload on it
// and the text and its delivery mode need the room the run page's dialog gives
// them.
//
// The list sits here rather than beside the server action that guards it
// because two callers read it. The action checks an incoming command against
// it before the kernel runs, and the row draws one button per entry. A
// `"use server"` module may export async functions and nothing else (INV-19,
// and Next.js refuses the build otherwise), so a value both sides read cannot
// live in one.

/**
 * The commands a run's row sends. `dispatch_command` refuses a payload on all three.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export const ROW_COMMANDS = ["pause", "resume", "cancel"] as const;
export type RowCommand = (typeof ROW_COMMANDS)[number];

/** Whether a command a form submitted is one of the three a row sends. */
export function isRowCommand(value: string): value is RowCommand {
  return ROW_COMMANDS.some((entry) => entry === value);
}
