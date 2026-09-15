// The one state for an unbacked slice (ARCHITECTURE.md §3.6, INV-18). A whole
// page outside the four rev1 pages is one row here, rendered by its route as
// <NotRecorded section=…/> until the gap lane that builds the page deletes the
// row in the PR that lands it. `run.frames_wrapped` is the one in-page row: a
// customer opening a wrapped run expects frames, and a silent absence reads as
// a defect. Every other unbacked in-page slice renders nothing. The table only
// shrinks; src/test/arch/unrecorded.test.ts holds it to these keys.
export const UNRECORDED = {
  tools: { gap: null },
  "run.frames_wrapped": { gap: "G6" },
} as const satisfies Record<string, { gap: `G${number}` | null }>;

export type UnrecordedKey = keyof typeof UNRECORDED;
