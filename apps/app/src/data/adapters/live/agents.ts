// The live agents adapter. Batch 3 lane A3 (agents + iam) wires each method to
// its store with a column-level mapping and a contract test that parses a real
// row through the view-model schema. Until then a method returns the milestone
// and gap it waits on (src/data/backing.ts), never a fabricated value.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { AgentReadPort } from "@/data/ports";

export const liveAgents: AgentReadPort = {
  listAgents: () => Promise.resolve(notBackedFor("agents", "listAgents")),
  getAgent: () => Promise.resolve(notBackedFor("agents", "getAgent")),
  toolbelt: () => Promise.resolve(notBackedFor("agents", "toolbelt")),
  definition: () => Promise.resolve(notBackedFor("agents", "definition")),
  scores: () => Promise.resolve(notBackedFor("agents", "scores")),
  incidents: () => Promise.resolve(notBackedFor("agents", "incidents")),
  mandates: () => Promise.resolve(notBackedFor("agents", "mandates")),
  getMandate: () => Promise.resolve(notBackedFor("agents", "getMandate")),
};
