import { z } from "zod";
import { registerCapability } from "../registry";
import { RELATIONSHIP_TYPE_PATTERN } from "../lib/relationship-type-pattern";

/**
 * graph.sync.push — idempotent, content-addressed batch upsert of code or
 * lineage subgraph nodes + edges into the workspace knowledge graph.
 *
 * Design: ADR-018 (CLI ↔ Workspace Graph Bidirectional Sync), slice 2.
 *
 * All nodes are written as `is_system = true`, keyed by a stable
 * content-addressed `key` (e.g. `code:{repo}:{path}` for files,
 * `code:{repo}:{path}#{symbol}:{kind}` for symbols). Re-sending the same
 * envelope with the same `idempotencyKey` is a no-op — every MERGE is
 * keyed so a re-push produces no database change.
 *
 * Tombstones soft-remove nodes (DETACH DELETE) by key. Removing a file from
 * git → tombstone that file and all its symbol nodes.
 *
 * Tenant isolation: every Cypher MERGEs on BOTH `orgId` AND `workspaceId`
 * so no cross-workspace collision or leak is possible.
 */
export const graphSyncPush = registerCapability({
  name: "push_graph",
  aliases: ["graph.sync.push"],
  domain: "graph",
  description:
    "Batch-upsert a content-addressed code or lineage subgraph into the workspace " +
    "knowledge graph. Idempotent — re-sending the same envelope is a no-op. Powers " +
    "`oxagen graph push` (code delta) and execution lineage up-sync (ADR-018 slice 2).",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "graph" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    source: z
      .enum(["code", "lineage"])
      .describe("Up-sync data source — `code` for repo code structure; `lineage` for execution traces."),
    idempotencyKey: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Content-addressed envelope key (e.g. `code:{repo}:{fromSHA}:{toSHA}`). " +
          "Re-sending the same key must be a no-op.",
      ),
    nodes: z.array(
      z.object({
        key: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "Stable content-addressed node key, e.g. `code:{repo}:{path}` (file) or " +
              "`code:{repo}:{path}#{symbol}:{kind}` (symbol). Becomes the naturalKey in Neo4j.",
          ),
        labels: z
          .array(z.string().min(1).max(100))
          .describe("Domain labels (e.g. [\"SourceFile\"], [\"Symbol\"]). The :GraphNode anchor is implicit."),
        displayName: z
          .string()
          .min(1)
          .max(500)
          .describe("Human-readable name (filename, symbol name, etc.)"),
        properties: z
          .record(z.unknown())
          .describe("Arbitrary key-value metadata (path, language, signature, etc.)"),
        isSystem: z
          .literal(true)
          .describe("Always true — sync'd nodes are product-owned (code graph / lineage)."),
        embedding: z
          .array(z.number())
          .optional()
          .describe(
            "Optional precomputed semantic embedding for this node. Must be a " +
              "1536-d `text-embedding-3-small` vector (the universal " +
              "`graph_node_embedding_index` dimension) or it is ignored — a wrong-" +
              "dimension vector is dropped rather than corrupting the index. Only " +
              "nodes the CLI embedded locally (with a gateway key) ship a vector; " +
              "the rest sync without one.",
          ),
      }),
    ).describe("Nodes to upsert. Empty array → only edges/tombstones are processed."),
    edges: z.array(
      z.object({
        sourceKey: z
          .string()
          .min(1)
          .max(500)
          .describe("Content-addressed key of the source node (must be in `nodes` or already in graph)."),
        targetKey: z
          .string()
          .min(1)
          .max(500)
          .describe("Content-addressed key of the target node."),
        type: z
          .string()
          .regex(
            RELATIONSHIP_TYPE_PATTERN,
            "Relationship type must be uppercase with underscores (e.g. IMPORTS, CONTAINS, CALLS).",
          )
          .describe("Relationship type — must match [A-Z][A-Z0-9_]{0,62}."),
        properties: z.record(z.unknown()).optional().describe("Optional edge metadata."),
        inferred: z
          .boolean()
          .optional()
          .describe("True for semantically inferred edges (not directly observed in code)."),
      }),
    ).describe("Edges to upsert between nodes by key. Both endpoints must exist in this push or in the graph."),
    tombstones: z
      .array(
        z.object({
          key: z.string().min(1).max(500).describe("Key of the node to soft-delete (DETACH DELETE)."),
        }),
      )
      .optional()
      .describe("Nodes to remove. Used when a file is deleted in git — tombstones that file + its symbols."),
  }),
  output: z.object({
    nodesUpserted: z
      .number()
      .int()
      .describe("Total nodes written (created or updated) in this push."),
    edgesUpserted: z
      .number()
      .int()
      .describe("Total edges written (created or updated) in this push."),
    tombstoned: z
      .number()
      .int()
      .describe("Total nodes removed (DETACH DELETE) from tombstone entries."),
  }),
});

export type GraphSyncPushInput = z.output<typeof graphSyncPush.input>;
export type GraphSyncPushOutput = z.output<typeof graphSyncPush.output>;
