// The live tools adapter. Batch 3 lane A4 (tools) wires each method to
// its store with a column-level mapping and a contract test that parses a real
// row through the view-model schema. Until then a method returns the milestone
// and gap it waits on (src/data/backing.ts), never a fabricated value.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { ToolReadPort } from "@/data/ports";

export const liveTools: ToolReadPort = {
  servers: () => Promise.resolve(notBackedFor("tools", "servers")),
  toolVersions: () => Promise.resolve(notBackedFor("tools", "toolVersions")),
  connections: () => Promise.resolve(notBackedFor("tools", "connections")),
  observedSchemas: () =>
    Promise.resolve(notBackedFor("tools", "observedSchemas")),
  mandateLedger: () => Promise.resolve(notBackedFor("tools", "mandateLedger")),
  policyVersions: () =>
    Promise.resolve(notBackedFor("tools", "policyVersions")),
  policySimulation: () =>
    Promise.resolve(notBackedFor("tools", "policySimulation")),
  killSwitches: () => Promise.resolve(notBackedFor("tools", "killSwitches")),
  autoApprovalRules: () =>
    Promise.resolve(notBackedFor("tools", "autoApprovalRules")),
  assurance: () => Promise.resolve(notBackedFor("tools", "assurance")),
};
