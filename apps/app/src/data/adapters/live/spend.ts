// The live spend adapter. Batch 3 lane A7 (spend + budgets) wires each method to
// its store with a column-level mapping and a contract test that parses a real
// row through the view-model schema. Until then a method returns the milestone
// and gap it waits on (src/data/backing.ts), never a fabricated value.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { SpendReadPort } from "@/data/ports";

export const liveSpend: SpendReadPort = {
  summary: () => Promise.resolve(notBackedFor("spend", "summary")),
  byOperator: () => Promise.resolve(notBackedFor("spend", "byOperator")),
  byAgent: () => Promise.resolve(notBackedFor("spend", "byAgent")),
  byModel: () => Promise.resolve(notBackedFor("spend", "byModel")),
  byTool: () => Promise.resolve(notBackedFor("spend", "byTool")),
  waste: () => Promise.resolve(notBackedFor("spend", "waste")),
  drill: () => Promise.resolve(notBackedFor("spend", "drill")),
  findings: () => Promise.resolve(notBackedFor("spend", "findings")),
  findingEvidence: () =>
    Promise.resolve(notBackedFor("spend", "findingEvidence")),
  findingFix: () => Promise.resolve(notBackedFor("spend", "findingFix")),
  reconciliation: () =>
    Promise.resolve(notBackedFor("spend", "reconciliation")),
  budgets: () => Promise.resolve(notBackedFor("spend", "budgets")),
};
