import { z } from "zod";
import { defineTool } from "./_define";
import { ontologyQuery } from "../ontology.query";
import { graphStats } from "../graph.stats";

/**
 * Appendix E: `query_graph` — "natural language to Cypher". Absorbs
 * `query_ontology` and `get_graph_stats`.
 *
 * §11.6 #4 is the whole design, and it is a design about not trusting a model:
 * the question is compiled to Cypher by a `complex`-tier call, and "what it
 * produces is never trusted as written". The Cypher is parsed against a clause
 * allowlist, the workspace predicate and label allowlists and a `LIMIT` are
 * *injected* by the graph service rather than left to the model, the plan is
 * checked with `EXPLAIN` against a node budget, and it runs on a read-only role
 * under the caller's time budget. A rejection is fed back to the compiler at
 * most twice before the tool returns a typed failure.
 *
 * The carry is therefore mostly a **removal**. `query_ontology` was the typed,
 * Cypher-free traversal primitive: start node, edge types, direction, depth.
 * §11.6 reassigns all of that to `expand_graph` (#3) and leaves `query_graph`
 * (#4) with no seed at all — a question, not a starting point. So the four
 * traversal inputs are dropped here and carried in `expand-graph.ts`, and what
 * survives from `query_ontology` is its *output*: the traversed node and edge
 * shapes with their bi-temporal validity, which are what the answer cites.
 *
 * `get_graph_stats` folds in because "how many customers do we have" and "how
 * big is the graph" are the same question asked of the same page, and a count
 * the graph service can answer deterministically should never become a compiled
 * query that might get it wrong.
 */
export const queryGraph = defineTool({
  name: "query_graph",
  domain: "graph",
  description:
    "Ask the workspace graph a question in plain English. The question is compiled to Cypher, parsed against a read-only clause allowlist, scoped and limited by the graph service, plan-checked, and executed. Returns the answer with the executed Cypher, the ontology version, and the cited nodes.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["query_ontology", "get_graph_stats"],
  drops: [
    {
      field: "startNodeId",
      from: "query_ontology",
      why: "§11.6 splits the two jobs: #3 `expand_graph` traverses FROM a node you already have, #4 `query_graph` answers a question with no seed. v1's own description warned 'do NOT use it to find a node by name, topic, or keyword' — that warning exists because the seed requirement was the wrong shape for a question, and v2 removes the requirement instead of restating the warning",
    },
    {
      field: "edgeTypes",
      from: "query_ontology",
      why: "the relationship allowlist is injected by the graph service from the caller's resource scope (§11.6 #4: 'the label and relationship allowlists from the caller's resource scope… are injected by the graph service, never left to the model'). A caller-supplied list would be a second, weaker filter next to the enforced one",
    },
    {
      field: "direction",
      from: "query_ontology",
      why: "a traversal parameter; carried to `expand_graph` (§11.6 #3). A compiled query expresses direction in its own pattern",
    },
    {
      field: "maxDepth",
      from: "query_ontology",
      why: "as `direction` — the hop budget is `expand_graph`'s. §11.6 #4 bounds a compiled query with an EXPLAIN node budget instead, which is what actually constrains a query whose shape the caller did not choose",
    },
    {
      field: "startNode",
      from: "query_ontology",
      why: "output; follows `startNodeId`. The nodes an answer cites are in `nodes`, and none of them is privileged as the start",
    },
    {
      field: "render",
      from: "get_graph_stats",
      why: "output; a render directive naming a chat UI component. §14.1 has one contract driving four surfaces, so a contract that names a component binds the schema to one of them. §14's interaction rule — 'every explanation is a chain of links to frames, records, and commits, not a summary' — is the second reason a stat box rendered from the tool's own instruction does not survive",
    },
    {
      field: "lastModifiedAt",
      from: "get_graph_stats",
      why: "output; a single wall-clock 'last modified' over a whole graph is not a fact §11.1's bi-temporal model can back — every node carries its own valid_from/recorded_at, and per-source freshness is on `list_sources`",
    },
  ],

  // Both sources are low/low/no-approval. §11.6 makes that safe by construction
  // rather than by grade: a write clause, a schema clause, or any non-allowlisted
  // procedure rejects the query before it runs, and it executes on a read-only
  // database role.
  agent: { requiresApproval: false, riskLevel: "low", category: "graph" },
  sensitivity: "low",
  defaultEffect: "deny",
  // `query_ontology` allows workspace Viewer; `get_graph_stats` allows
  // Owner/Member only. The stricter carries — Viewer does not.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  /**
   * Verified in ontology.query.ts and graph.stats.ts: both read and write
   * nothing, and §11.6 states all four graph reads "are read-only". The
   * compiler's model call and §11.6's recorded-query cache ("identical questions
   * against the same ontology version are served from the recorded query") are
   * frames written by the recorder, not writes this tool performs against
   * customer data.
   */
  mutates: false,

  input: z.object({
    /**
     * New. No absorbed contract took a natural-language question —
     * `query_ontology` took a node and a depth. §11.6 warns that "questions are
     * untrusted text. Nothing in them reaches Cypher except through the
     * compiler", which is why this is a bounded string and not a structured
     * query object: there is nothing here for a caller to smuggle a clause
     * through, because the whole field is treated as prose.
     */
    question: z.string().min(1).max(2000),

    /**
     * Carried from `query_ontology`: 1–500, default 100. §11.6 #4 says the
     * `LIMIT` is injected by the graph service and never left to the model, so
     * this is the caller's ceiling that the service injects — not a hint the
     * compiler is asked to respect.
     */
    limit: ontologyQuery.input.shape.limit,

    /**
     * Carried by import. §11.6: "`as_of` applies to all four, using the node and
     * edge temporal fields. So 'what did we know about this account in June' is
     * a query, not an export." The two axes keep their documented distinction:
     * `asOf` is what was true, `asKnownAt` is what we had recorded.
     */
    asOf: ontologyQuery.input.shape.asOf,
    asKnownAt: ontologyQuery.input.shape.asKnownAt,

    /**
     * Carried from `get_graph_stats`, defaults intact. Set either and the
     * deterministic counts come back in `stats` — the counting questions
     * answered by the graph service rather than by a compiled query that could
     * get an aggregate subtly wrong.
     */
    includeByType: graphStats.input.shape.includeByType,
    includeGrowth: graphStats.input.shape.includeGrowth,
  }),

  output: z.object({
    /**
     * §11.6 #4: "the answer carries the executed Cypher, the ontology version,
     * the nodes it cited as context frames, and a confidence that is the
     * compiler's, labeled as such." All four are here, and `confidenceBasis` is
     * the labelling — §14 requires every trust badge to show the recorded value
     * and nothing stronger, and a compiler's self-reported confidence is the
     * weakest kind of recorded value there is.
     */
    answer: z.string(),
    cypher: z
      .string()
      .describe(
        "The Cypher actually executed, after injection of the workspace predicate, allowlists and LIMIT",
      ),
    ontologyVersionId: z
      .string()
      .describe("The active ontology version the compiler was given"),
    confidence: z.number().min(0).max(1),
    confidenceBasis: z.literal("compiler"),

    /**
     * The cited subgraph, carried whole from `query_ontology`'s outputs. Nodes
     * keep their `depth`; edges keep the bi-temporal validity fields that let an
     * answer say "true as of X". §11.6: "Every linked node is cited in the
     * answer, so a wrong link is visible."
     */
    nodes: ontologyQuery.output.shape.nodes,
    edges: ontologyQuery.output.shape.edges,
    truncated: ontologyQuery.output.shape.truncated,

    /**
     * §11.6 #4's typed failure: "a syntax or plan rejection is fed back to the
     * compiler at most twice, with the error, before the agent tool returns a
     * typed failure." Null on success. `attempts` is carried so a caller can see
     * the retries happened — a question answered on the third compile is not the
     * same evidence as one answered on the first.
     */
    rejection: z
      .object({
        stage: z.enum(["parse", "plan", "timeout"]),
        reason: z.string(),
        attempts: z.number().int().min(1).max(3),
      })
      .nullable(),

    /**
     * Present when either stats flag is set. Carried from `get_graph_stats` —
     * the deterministic counts, the per-label and per-type breakdowns, and the
     * 14-day creation series with its zero-filling and UTC-day semantics
     * documented on the field.
     */
    stats: z
      .object({
        nodeCount: graphStats.output.shape.nodeCount,
        edgeCount: graphStats.output.shape.edgeCount,
        inferredEdgeCount: graphStats.output.shape.inferredEdgeCount,
        sourceCount: graphStats.output.shape.sourceCount,
        nodesByLabel: graphStats.output.shape.nodesByLabel,
        edgesByType: graphStats.output.shape.edgesByType,
        growth: graphStats.output.shape.growth,
      })
      .optional(),
  }),
});

export type QueryGraphInput = z.output<typeof queryGraph.input>;
export type QueryGraphOutput = z.output<typeof queryGraph.output>;
