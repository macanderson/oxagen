// The live steering adapter. Batch 3 lane A6 (steering) wires each method to
// its store with a column-level mapping and a contract test that parses a real
// row through the view-model schema. Until then a method returns the milestone
// and gap it waits on (src/data/backing.ts), never a fabricated value.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { SteeringReadPort } from "@/data/ports";

export const liveSteering: SteeringReadPort = {
  records: () => Promise.resolve(notBackedFor("steering", "records")),
  proposals: () => Promise.resolve(notBackedFor("steering", "proposals")),
  effect: () => Promise.resolve(notBackedFor("steering", "effect")),
  retirementCandidates: () =>
    Promise.resolve(notBackedFor("steering", "retirementCandidates")),
};
