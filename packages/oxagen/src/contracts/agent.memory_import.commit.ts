import { z } from "zod";
import { registerCapability } from "../registry";
import { memoryImportDraftSchema } from "./agent.memory_import.shared";

/**
 * agent.memory.import.commit — the second half of bulk memory import.
 *
 * Accepts the (edited, confirmed) draft memories produced by
 * agent.memory.import.parse and writes each into the workspace AgentMemory graph
 * — the same Neo4j store agent.memory.write / .remember / .list use. Each draft
 * is embedded and written independently with per-item error capture, so one bad
 * row never fails the batch (mirrors plugin.org.install_bulk). The result array
 * is positional: result[i] corresponds to drafts[i].
 *
 * Mode is sync + batch. Each write embeds the lesson (a metered AI call), run
 * with bounded concurrency in the handler. For very large imports the caller
 * should split across multiple commit calls.
 */
export const agentMemoryImportCommit = registerCapability({
  name: "commit_memory_import",
  domain: "agent",
  description:
    "Write a batch of confirmed draft memories into the workspace AgentMemory graph. Per-item error capture — not all-or-nothing. Backs the bulk-import button.",
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
    drafts: z
      .array(memoryImportDraftSchema)
      .min(1)
      .max(200)
      .describe("The confirmed draft memories to persist (max 200 per call)"),
  }),
  output: z.object({
    results: z
      .array(
        z.object({
          lesson: z
            .string()
            .describe("Echo of the draft lesson, for client reconciliation"),
          ok: z.boolean(),
          memoryId: z
            .string()
            .nullable()
            .describe(
              "Neo4j node id of the written memory, or null on failure",
            ),
          error: z
            .string()
            .nullable()
            .describe("Failure reason, or null on success"),
        }),
      )
      .describe("Positional results — results[i] corresponds to drafts[i]"),
    imported: z.number().describe("Count of drafts written successfully"),
    failed: z.number().describe("Count of drafts that failed to write"),
  }),
});

export type AgentMemoryImportCommitInput = z.input<
  typeof agentMemoryImportCommit.input
>;
export type AgentMemoryImportCommitOutput = z.output<
  typeof agentMemoryImportCommit.output
>;
