import { z } from "zod";
import { registerCapability } from "../registry";
import { LABEL_PATTERN } from "../lib/label-pattern";

/**
 * Remove one or more labels from a node, multi-label-agnostic. Removing a label
 * the node does not have is a no-op. Never touches the node's other labels or
 * its properties. The complement of graph.node.label.add (e.g. drop a `:Billing`
 * domain label without disturbing `:Payment`).
 *
 * Labels validated by LABEL_PATTERN (Cypher-injection guard) only — no registry
 * membership check.
 */
export const graphNodeLabelRemove = registerCapability({
  name: "remove_node_label",
  domain: "graph",
  description: "Remove one or more labels from a node (multi-label, idempotent, leaves other labels intact).",
  mode: "sync",
  surfaces: ["agent"] as const,
  layers: ["schema", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "low", category: "graph" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    nodeId: z.string().min(1).describe("publicId of the target node"),
    labels: z.array(z.string().regex(LABEL_PATTERN)).min(1).describe("Labels to remove"),
  }),
  output: z.object({
    nodeId: z.string(),
    labels: z.array(z.string()).describe("The node's full label set after the remove"),
    removed: z.array(z.string()).describe("Labels that were present and got removed"),
  }),
});

export type GraphNodeLabelRemoveInput = z.output<typeof graphNodeLabelRemove.input>;
export type GraphNodeLabelRemoveOutput = z.output<typeof graphNodeLabelRemove.output>;
