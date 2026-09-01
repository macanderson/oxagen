import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * Read the full label set of a customer-context node. Product-owned runtime
 * nodes are intentionally available only through their typed domain APIs.
 */
export const graphNodeLabelsGet = registerCapability({
  name: "get_node_labels",
  domain: "graph",
  description: "Read a customer-context node's full label set.",
  mode: "sync",
  surfaces: ["agent"] as const,
  layers: ["schema", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "graph" },
  sensitivity: "low",
  mutates: false,
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
export type GraphNodeLabelsGetOutput = z.output<
  typeof graphNodeLabelsGet.output
>;
