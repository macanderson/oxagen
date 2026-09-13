// The live billing adapter. Batch 3 lane A9 (billing) wires each method to
// its store with a column-level mapping and a contract test that parses a real
// row through the view-model schema. Until then a method returns the milestone
// and gap it waits on (src/data/backing.ts), never a fabricated value.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { BillingReadPort } from "@/data/ports";

export const liveBilling: BillingReadPort = {
  plan: () => Promise.resolve(notBackedFor("billing", "plan")),
  allowance: () => Promise.resolve(notBackedFor("billing", "allowance")),
  meters: () => Promise.resolve(notBackedFor("billing", "meters")),
  invoices: () => Promise.resolve(notBackedFor("billing", "invoices")),
};
