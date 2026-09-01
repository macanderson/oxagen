import { z } from "zod";
import { registerCapability } from "../registry";
import { memoryImportDraftSchema } from "./agent.memory_import.shared";

/**
 * agent.memory.import.parse — the first half of bulk memory import.
 *
 * Accepts a batch of uploaded markdown documents (skill files, rule docs,
 * playbooks) and uses the AI gateway to extract atomic, self-contained memories
 * from each, classifying every one into a kind + weight per the AgentMemory
 * taxonomy. It writes NOTHING — it returns a flat array of editable drafts the
 * caller (the app's review grid, the CLI, an agent) confirms or edits before
 * handing them to agent.memory.import.commit.
 *
 * Mode is sync + batch: one generateObject call per document, run concurrently.
 * For very large libraries the caller should chunk across multiple parse calls;
 * the per-call document/size caps keep a single request bounded.
 */
export const agentMemoryImportParse = registerCapability({
  name: "parse_memory_import",
  domain: "agent",
  description:
    "Parse a batch of uploaded markdown documents into draft AgentMemory records, classifying each by kind + weight. Read-only: returns editable drafts for review, persists nothing.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "medium",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    documents: z
      .array(
        z.object({
          filename: z
            .string()
            .min(1)
            .max(256)
            .describe("Original filename, used as provenance on each draft"),
          content: z
            .string()
            .min(1)
            .max(100_000)
            .describe("Raw markdown content of the document"),
        }),
      )
      .min(1)
      .max(25)
      .describe("The uploaded documents to extract memories from (max 25 per call)"),
    defaultNodeRef: z
      .string()
      .max(256)
      .optional()
      .describe(
        "Graph node id to anchor every extracted draft on; defaults to the 'user-memory' bucket",
      ),
  }),
  output: z.object({
    drafts: z
      .array(memoryImportDraftSchema)
      .describe("Extracted, classified, editable draft memories across all documents"),
    documentCount: z.number().describe("Number of documents that yielded at least one draft"),
    skipped: z
      .array(
        z.object({
          filename: z.string(),
          reason: z.string(),
        }),
      )
      .describe("Documents that produced no drafts (empty, unparseable, or model error)"),
  }),
});

export type AgentMemoryImportParseInput = z.input<typeof agentMemoryImportParse.input>;
export type AgentMemoryImportParseOutput = z.output<typeof agentMemoryImportParse.output>;
