import { z } from "zod";
import { registerCapability } from "../registry";
import { knowledgeNodeRefSchema } from "./semantic.edge.list";

/**
 * agent.execution.lineage — the file-level lineage of one agent execution.
 *
 * Returns the `:Execution` graph node for a run PLUS every `:SourceFile` it
 * touched via `(:Execution)-[:TOUCHED_FILE]->(:SourceFile)` (written by
 * `packages/ontology/src/mutations/record-execution.ts`, invoked from the
 * durable execution-sync path — see
 * `packages/inngest-functions/src/functions/agent.sync-execution-to-graph.ts`).
 * This is the auditable-graph proof: not "what files did this agent report
 * editing" as a flat list, but the real, queryable graph of what an
 * execution actually touched — the same lineage a customer can inspect and
 * cite.
 *
 * Both endpoints are resolved server-side to the shared `KnowledgeNodeRef`
 * shape ({ id, label, displayName, properties }) so the UI cites them by human
 * label with an inspectable property bag and renders them on the shared
 * knowledge-graph canvas — never a bare UUID (CLAUDE.md "Citing nodes & edges").
 *
 * Org + workspace scoped, read-only. The `:Execution` is matched within the
 * caller's org+workspace; its `:SourceFile` neighbours are org-scoped (a source
 * file is shared across an org's workspaces for the same repo), reached only via
 * the tenant-scoped execution's edges.
 */

const touchedFileEntry = z.object({
  node: knowledgeNodeRefSchema.describe(
    "The touched source file, resolved to a citable KnowledgeNodeRef",
  ),
  edgeType: z
    .string()
    .describe(
      "Relationship type connecting the execution to the file (TOUCHED_FILE)",
    ),
});

export const agentExecutionLineage = registerCapability({
  name: "get_execution_lineage",
  domain: "agent",
  description:
    "Get one agent execution's file-level lineage as a graph — the :Execution node plus every :SourceFile it touched via TOUCHED_FILE edges. Proves, as a real queryable graph, exactly which files an agent run modified.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    executionId: z
      .string()
      .describe(
        "publicId / id of the :Execution graph node whose lineage to fetch",
      ),
  }),
  output: z.object({
    found: z
      .boolean()
      .describe(
        "True if the execution exists as a node in this org + workspace",
      ),
    execution: knowledgeNodeRefSchema
      .nullable()
      .describe(
        "The execution node, resolved to a citable KnowledgeNodeRef; null when not found",
      ),
    files: z
      .array(touchedFileEntry)
      .describe(
        "Every source file this execution touched, with its TOUCHED_FILE edge",
      ),
  }),
});

export type AgentExecutionLineageInput = z.output<
  typeof agentExecutionLineage.input
>;
export type AgentExecutionLineageOutput = z.output<
  typeof agentExecutionLineage.output
>;
