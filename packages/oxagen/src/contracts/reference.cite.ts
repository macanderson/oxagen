import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * reference.cite — record that a chat turn deliberately referenced
 * knowledge-graph nodes via @-mentions.
 *
 * A manual mention is a citation: it MERGEs the turn's :Execution, writes a
 * :Citation (source 'mention', influence DECISIVE — the user attached it on
 * purpose) linked (execution)-[:CITED]->(citation)-[:OF]->(node), and
 * increments `citation_count` on the node — the same counter the agent's
 * automatic memory citations maintain, so manual and automatic references
 * accrue identically. :AgentMemory nodes additionally get their
 * `influence_count` bumped, matching cite_memory's DECISIVE semantics.
 *
 * Agent-surface only: invoked fire-and-forget by chat routes while weaving
 * mention context into the turn; not a user-facing API/MCP action.
 */
export const referenceCite = registerCapability({
  name: "cite_reference",
  domain: "reference",
  description:
    "Record @-mention citations of knowledge-graph nodes within a chat execution — " +
    "creates :Citation lineage and increments the node's citation_count (plus " +
    "influence_count for AgentMemory nodes), identical to automatic citations.",
  mode: "sync",
  surfaces: ["agent"] as const,
  layers: ["schema", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    executionRef: z
      .string()
      .min(1)
      .describe(
        "Execution id (chat turn messageId) to attach citations to; MERGEd if absent",
      ),
    agentId: z.string().optional(),
    taskSummary: z.string().max(500).optional(),
    references: z
      .array(
        z.object({
          nodeId: z
            .string()
            .min(1)
            .describe("publicId of the mentioned :GraphNode"),
        }),
      )
      .min(1)
      .max(32),
  }),
  output: z.object({
    executionId: z.string(),
    results: z.array(
      z.object({
        nodeId: z.string(),
        ok: z.boolean(),
        citationId: z.string().nullable(),
        error: z.string().nullable(),
      }),
    ),
    recorded: z.number().int().nonnegative(),
  }),
});

export type ReferenceCiteInput = z.output<typeof referenceCite.input>;
export type ReferenceCiteOutput = z.output<typeof referenceCite.output>;
