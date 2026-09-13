// The live runs adapter. Batch 3 lane A1 (runs + frames) wires each method to
// its store with a column-level mapping and a contract test that parses a real
// row through the view-model schema. Until then a method returns the milestone
// and gap it waits on (src/data/backing.ts), never a fabricated value.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { RunReadPort } from "@/data/ports";

export const liveRuns: RunReadPort = {
  listRuns: () => Promise.resolve(notBackedFor("runs", "listRuns")),
  getRun: () => Promise.resolve(notBackedFor("runs", "getRun")),
  framesSince: () => Promise.resolve(notBackedFor("runs", "framesSince")),
  transcript: () => Promise.resolve(notBackedFor("runs", "transcript")),
  runGraph: () => Promise.resolve(notBackedFor("runs", "runGraph")),
  contextWindow: () => Promise.resolve(notBackedFor("runs", "contextWindow")),
  proof: () => Promise.resolve(notBackedFor("runs", "proof")),
};
