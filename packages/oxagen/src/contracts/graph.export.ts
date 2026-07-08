import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * graph.export — paginated, cursor-aware read of a workspace subgraph (nodes +
 * edges) for downloading into a local projection (the CLI's DuckDB read-replica).
 *
 * Unlike graph.node.list (UI browse), this is built for *sync*: it returns edges
 * alongside nodes, keys everything by the stable `publicId` (so a local copy can
 * be re-pulled and reconciled deterministically), and supports incremental
 * refresh via `updatedAfter` + a returned `cursor` (the max updatedAt in the
 * page). See ADR-018. Source of truth stays the workspace graph; the local copy
 * is a refreshable read-replica.
 */
export const graphExport = registerCapability({
  name: "export_graph",
  domain: "graph",
  description:
    "Export a workspace subgraph (nodes + edges) for a local projection. Cursor-aware " +
    "incremental read keyed by publicId; powers `oxagen graph pull`.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    labels: z
      .array(z.string())
      .optional()
      .describe("Restrict to these node labels (e.g. Feature, Issue). Omit for all."),
    isSystem: z
      .boolean()
      .optional()
      .describe(
        "false = customer ontology only; true = product-owned artifacts (code, executions, " +
          "memories) only; omit for both.",
      ),
    updatedAfter: z
      .string()
      .optional()
      .describe("ISO-8601 high-watermark — return only nodes updated strictly after this (incremental pull)."),
    includeEdges: z
      .boolean()
      .default(true)
      .describe("Include edges between returned nodes (set false for a nodes-only page)."),
    limit: z.number().int().min(1).max(1000).default(500).describe("Max nodes per page (default 500)"),
    offset: z.number().int().min(0).default(0).describe("Pagination offset (use cursor for incremental)"),
  }),
  output: z.object({
    nodes: z.array(
      z.object({
        id: z.string().describe("Stable publicId — the local copy's primary key"),
        labels: z.array(z.string()).describe("Node labels (domain + anchor)"),
        displayName: z.string(),
        properties: z.record(z.unknown()).describe("Full property bag"),
        sourceId: z.string().optional().describe("Source connector id, if any"),
        isSystem: z.boolean().describe("Product-owned (code/execution/memory) vs customer ontology"),
        updatedAt: z.string().optional().describe("ISO-8601 last-update timestamp"),
      }),
    ),
    edges: z.array(
      z.object({
        id: z.string().describe("Stable edge id"),
        sourceId: z.string().describe("publicId of the source node"),
        targetId: z.string().describe("publicId of the target node"),
        type: z.string().describe("Relationship type"),
        properties: z.record(z.unknown()).describe("Edge property bag"),
        inferred: z.boolean().describe("True for semantically-inferred edges"),
      }),
    ),
    total: z.number().describe("Total nodes matching the filter (for progress)"),
    hasMore: z.boolean().describe("Whether more nodes exist beyond this page"),
    limit: z.number(),
    offset: z.number(),
    cursor: z
      .string()
      .nullable()
      .describe("Max updatedAt in this page — pass as updatedAfter to continue incrementally"),
  }),
});

export type GraphExportInput = z.output<typeof graphExport.input>;
export type GraphExportOutput = z.output<typeof graphExport.output>;
