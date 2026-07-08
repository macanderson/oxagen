import { z } from "zod";
import { registerCapability } from "../registry";
import { RELATIONSHIP_TYPE_PATTERN } from "../lib/relationship-type-pattern";

/**
 * graph.ingest — turn raw text into knowledge-graph nodes + edges.
 *
 * This is the missing ingestion link: it reads the workspace graph prompt (and
 * any provided type hints) to decide which entity/edge types matter, runs
 * LLM-driven entity + relationship extraction (with confidence, following the
 * seeded entity-extractor / relationship-extractor / graph-ingestion skills'
 * discipline of restraint), and commits the results through graph.node.upsert /
 * graph.edge.upsert (idempotent MERGE — the upsert IS the entity resolution).
 *
 * The research swarm, data connectors, and the in-chat agent all feed text here
 * to grow the customer's ontology.
 */

export const graphIngest = registerCapability({
  name: "graph.ingest",
  domain: "graph",
  description:
    "Extract entities and relationships from text and commit them to the knowledge graph as " +
    "nodes and edges, with confidence labels. Reads the workspace graph prompt (and optional " +
    "type hints) to decide which entity/edge types to look for, then upserts (idempotent — the " +
    "upsert resolves duplicates). The bridge from web-search / document text to the ontology.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  agent: { requiresApproval: false, riskLevel: "medium", category: "knowledge" },
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  consumes: ["document.text", "search.results"],
  produces: ["graph.nodeId", "graph.relationshipId"],
  chainHints: ["graph.node.list", "document.generate"],
  render: { componentId: "graph-ingest-card" },
  input: z.object({
    text: z
      .string()
      .min(1)
      .max(100_000)
      .describe("The source text to extract entities and relationships from"),
    sourceUrl: z
      .string()
      .optional()
      .describe("Provenance — where the text came from (stored on created nodes)"),
    entityTypeHints: z
      .array(z.string())
      .optional()
      .describe(
        "Entity types (node labels) to look for. When omitted, the workspace graph prompt is used.",
      ),
    maxEntities: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(25)
      .describe("Cap on the number of entities to extract"),
  }),
  output: z.object({
    entities: z.array(
      z.object({
        nodeId: z.string(),
        name: z.string(),
        type: z.string(),
        confidence: z.number(),
        created: z.boolean(),
      }),
    ),
    relationships: z.array(
      z.object({
        relationshipId: z.string(),
        from: z.string(),
        to: z.string(),
        relationshipType: z.string().regex(RELATIONSHIP_TYPE_PATTERN),
        confidence: z.number(),
        created: z.boolean(),
      }),
    ),
    summary: z.string().describe("Plain-language summary of what was ingested"),
  }),
});

export type GraphIngestInput = z.output<typeof graphIngest.input>;
export type GraphIngestOutput = z.output<typeof graphIngest.output>;
