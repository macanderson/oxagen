// The live approvals adapter. Batch 3 lane A2 (approvals + commands) wires each method to
// its store with a column-level mapping and a contract test that parses a real
// row through the view-model schema. Until then a method returns the milestone
// and gap it waits on (src/data/backing.ts), never a fabricated value.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { ApprovalReadPort } from "@/data/ports";

export const liveApprovals: ApprovalReadPort = {
  pending: () => Promise.resolve(notBackedFor("approvals", "pending")),
};
