import { z } from "zod";
import { registerCapability } from "../registry";
import { agentMemoryRecordSchema } from "./agent.memory.list";

/**
 * agent.memory.update — edit an existing AgentMemory in place.
 *
 * Covers the three manage-my-memory verbs the CLI and Knowledge → Memories
 * surface need beyond write/recall/list: change the lesson text, re-categorise
 * the kind/source, and adjust salience (the `weight` bucket and the numeric
 * `confidence`). When the lesson changes the handler re-embeds so semantic
 * recall stays accurate against the new text.
 *
 * `memoryId` is the node id (not publicId). All other fields are optional; the
 * handler rejects a call that changes nothing rather than encode the
 * "at least one" rule with `.refine()`, which would turn `input` into a
 * ZodEffects and break the MCP tool's `input.shape` spread.
 */
export const agentMemoryUpdate = registerCapability({
  name: "agent.memory.update",
  domain: "agent",
  description:
    "Edit an AgentMemory: change its lesson, kind, source, or salience (weight + confidence). Re-embeds when the lesson changes so semantic recall stays accurate.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    memoryId: z
      .string()
      .min(1)
      .describe("The AgentMemory node id (not publicId) to update"),
    lesson: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe("Replacement lesson text; triggers a re-embed for semantic recall"),
    weight: z
      .enum(["low", "high", "critical"])
      .optional()
      .describe("New salience bucket (low sinks below default recall; critical never decays)"),
    kind: z
      .enum([
        "routine-change",
        "constraint",
        "bug-root-cause",
        "convention-deviation",
        "gotcha",
      ])
      .optional()
      .describe("New memory category"),
    source: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("New provenance label (e.g. user, feature, fix)"),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("New numeric salience/confidence (0–1); the decay pass evolves it over time"),
  }),
  output: agentMemoryRecordSchema,
});

export type AgentMemoryUpdateInput = z.output<typeof agentMemoryUpdate.input>;
export type AgentMemoryUpdateOutput = z.output<typeof agentMemoryUpdate.output>;
