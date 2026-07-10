import { z } from "zod";
import { registerCapability } from "../registry";
import { LABEL_PATTERN } from "../lib/label-pattern";

// Re-export the label guard so handlers can import it from the contract layer
// (matches how RELATIONSHIP_TYPE_PATTERN is surfaced via graph.edge.upsert).
export { LABEL_PATTERN, assertSafeLabel } from "../lib/label-pattern";

/**
 * Apply one or more labels to an existing node, multi-label-agnostic: it does
 * NOT care how many labels the node already carries, has no "primary label"
 * concept, and never overwrites or removes existing labels. Idempotent —
 * re-adding a label a node already has is a no-op. This is the primitive the
 * Domain model rides on (e.g. tag `:Billing` onto a node that is already
 * `:Payment`, yielding `:Billing:Payment`).
 *
 * Labels are validated by LABEL_PATTERN (Cypher-injection guard) only — there
 * is intentionally NO registry / active-vocabulary membership check here. This
 * is a free graph primitive; semantic governance happens elsewhere.
 */
export const graphNodeLabelAdd = registerCapability({
  name: "add_node_label",
  domain: "graph",
  description:
    "Add one or more labels to a node (multi-label, idempotent, never removes existing labels).",
  mode: "sync",
  // Agent + ingestion primitive. Not on api/mcp/cli surfaces yet — keep the
  // surface set truthful so the route/tool parity guards hold.
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
    labels: z
      .array(z.string().regex(LABEL_PATTERN))
      .min(1)
      .describe("Labels to add (e.g. ['Billing'] or ['Billing','Pii'])"),
  }),
  output: z.object({
    nodeId: z.string(),
    labels: z
      .array(z.string())
      .describe("The node's full label set after the add"),
    added: z.array(z.string()).describe("Labels that were not already present"),
  }),
});

export type GraphNodeLabelAddInput = z.output<typeof graphNodeLabelAdd.input>;
export type GraphNodeLabelAddOutput = z.output<typeof graphNodeLabelAdd.output>;
