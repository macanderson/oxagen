/**
 * `search_steering`: find the steering records and skills an agent's index did
 * not list (steering-repo-spec, Agent use).
 *
 * It searches the two published versions the caller's workspace reads, the
 * workspace's steering repo and the organization repo, and answers one index
 * line per hit. It finds no tools: tools come from the tool list or a
 * server's own search tool. The agent reads a hit's body with read_steering.
 *
 * Cursor reaches steering only through these two tools. Its model calls go to
 * Cursor's servers, so no steering block reaches its requests, and a rule in
 * Cursor's dashboard tells it to call them (packages/steering-bundle/src/
 * cursor.ts).
 *
 * The spec proposed the name `steering_search`. ADR-025 puts the verb first,
 * so the capability is `search_steering`, the name of the function that
 * answers it in @oxagen/steering-bundle.
 */
import { registerCapability } from "../registry";
import {
  steeringSearchInputSchema,
  steeringSearchOutputSchema,
} from "../steering-repo/steering-tools";

export const steeringSearch = registerCapability({
  name: "search_steering",
  domain: "context",
  description:
    "Find the steering records and skills in the workspace's and the organization's published steering that match words, a kind, or a code repository. Returns one index line per hit, and marks the records every request on that repository already receives. Read a hit's body with read_steering. Finds no tools.",
  mode: "sync",
  surfaces: ["mcp"],
  layers: ["schema", "mcp", "unit", "docs"],
  scoped: true,
  // An agent calls it at the start of every task. Metering it would bill a
  // customer for the steering their own workspace published.
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "context" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  // A Viewer may call it too: it reads steering the workspace already
  // published and changes nothing.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: steeringSearchInputSchema,
  output: steeringSearchOutputSchema,
});
