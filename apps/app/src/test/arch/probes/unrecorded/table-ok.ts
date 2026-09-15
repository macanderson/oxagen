// Probe for unrecorded.test.ts: the five §3.6 rows, as src/data/unrecorded.ts spells them.
export const UNRECORDED = {
  agents: { gap: null },
  tools: { gap: null },
  steering: { gap: null },
  spend: { gap: null },
  "run.frames_wrapped": { gap: "G6" },
} as const satisfies Record<string, { gap: `G${number}` | null }>;
