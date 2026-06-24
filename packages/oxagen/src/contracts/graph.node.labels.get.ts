import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * Read the full label set of a node. Read-only companion to
 * graph.node.label.add / .remove — useful for verifying multi-label state and
 * for a curator agent to inspect which domains a node belongs to.
 */
export const graphNodeLabelsGet = registerCapability({
  name: "graph.node.labels.get",
  domain: "graph",
  description: "Read a node's full label set.",
  mode: "sync",
  surfaces: ["agent"] as const,
  layers: ["schema", "unit"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "graph" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    nodeId: z.string().min(1).describe("publicId of the target node"),
  }),
  output: z.object({
    nodeId: z.string(),
    labels: z.array(z.string()),
  }),
});

export type GraphNodeLabelsGetInput = z.output<typeof graphNodeLabelsGet.input>;
export type GraphNodeLabelsGetOutput = z.output<typeof graphNodeLabelsGet.output>;
