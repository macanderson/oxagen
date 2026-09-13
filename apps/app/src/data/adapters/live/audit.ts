// The live audit adapter. Batch 3 lane A10 (audit + shell) wires each method to
// its store with a column-level mapping and a contract test that parses a real
// row through the view-model schema. Until then a method returns the milestone
// and gap it waits on (src/data/backing.ts), never a fabricated value.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { AuditReadPort } from "@/data/ports";

export const liveAudit: AuditReadPort = {
  events: () => Promise.resolve(notBackedFor("audit", "events")),
  incidents: () => Promise.resolve(notBackedFor("audit", "incidents")),
  receipts: () => Promise.resolve(notBackedFor("audit", "receipts")),
  getReceipt: () => Promise.resolve(notBackedFor("audit", "getReceipt")),
  holds: () => Promise.resolve(notBackedFor("audit", "holds")),
  exports: () => Promise.resolve(notBackedFor("audit", "exports")),
  keys: () => Promise.resolve(notBackedFor("audit", "keys")),
  erasure: () => Promise.resolve(notBackedFor("audit", "erasure")),
  retention: () => Promise.resolve(notBackedFor("audit", "retention")),
  assuranceHistory: () =>
    Promise.resolve(notBackedFor("audit", "assuranceHistory")),
};
