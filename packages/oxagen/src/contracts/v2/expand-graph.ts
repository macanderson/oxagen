import { z } from "zod";
import { defineTool } from "./_define";
import { ontologyNeighbors } from "../ontology.neighbors";
import { ontologyQuery } from "../ontology.query";
import { graphNodeGet } from "../graph.node.get";

/**
 * Appendix E: `expand_graph` — "typed traversal". Absorbs
 * `get_ontology_neighbors` and `get_node`.
 *
 * §11.6 #3: "typed traversal from seed nodes (by id or from a search) along
 * allowed relationship types, up to a hop budget. It returns a subgraph as
 * `graph` frames whose `relations[]` carry the edges. This is how 'everything
 * connected to Customer X' and 'what does this symbol call' are answered without
 * generating a query."
 *
 * Two judgment calls:
 *
 * 1. **The hop budget is imported from `query_ontology`, a contract this tool
 *    does not absorb.** `get_ontology_neighbors` is depth 1 by construction;
 *    §11.6 gives `expand_graph` a budget. Rather than retype a bound, `maxDepth`
 *    comes from `query_ontology.input.shape` — the 1–5 cap and its default of 2
 *    are already tuned against the graph service's node budget, and duplicating
 *    them by hand is how the two limits drift apart. `query_ontology` itself
 *    belongs to `query_graph`, where it contributes the natural-language path;
 *    its traversal parameters land here, where §11.6 puts traversal.
 *
 * 2. **The seed stays singular even though §11.6 says "seed nodes".** The
 *    accountability chain is the reason. `get_ontology_neighbors` declares
 *    `audit: { targetKind: "graph.node", targetIdField: "nodeId" }`, and the
 *    kernel reads `input[targetIdField]` for **string values only**
 *    (packages/oxagen/src/kernel.ts:945). An array seed would type-check and
 *    silently produce audit rows with no target, so "who has read node N" would
 *    stop being answerable for exactly the expansions that touched the most
 *    nodes. A batched seed list is worth having, but it needs the kernel to
 *    learn array targets first — it is not worth buying by dropping the audit
 *    row.
 */
export const expandGraph = defineTool({
  name: "expand_graph",
  domain: "graph",
  description:
    "Typed traversal from a seed node along allowed relationship types, up to a hop budget. Returns the reachable subgraph as nodes and edges with bi-temporal validity. Read-only; no Cypher required.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["get_ontology_neighbors", "get_node"],
  drops: [
    {
      field: "node",
      from: "get_node",
      why: "output; v1 returned a single nullable node. A traversal returns a set, so the seed appears in `nodes` at depth 0 and its absence is reported by `found` — carried from `get_ontology_neighbors`, which already had the right shape for 'the seed does not exist in this org + workspace'",
    },
    {
      field: "nodeId",
      from: "get_ontology_neighbors",
      why: "output; the echo of the request. Replaced by `seedNodeId`, which says the same thing in a response that now also contains other nodes' ids",
    },
    {
      field: "direction",
      from: "get_ontology_neighbors",
      why: "output; the per-neighbour in/out flag. A multi-hop result cannot express direction relative to the seed, so edges carry explicit `fromNodeId`/`toNodeId` instead — the input `direction` filter is unchanged",
    },
  ],

  // Both sources are low/low/no-approval and both declare mutates: false.
  agent: { requiresApproval: false, riskLevel: "low", category: "graph" },
  sensitivity: "low",
  defaultEffect: "deny",
  // Both sources agree, Viewer included — this is the one read in the batch
  // whose sources do not disagree, so the Viewer allowance survives.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  /**
   * Carried from `get_ontology_neighbors`. §6.10: a graph read acts on a
   * specific node, and recording it as the audit row's target is what makes
   * "who has read node N" queryable. Preserving this is why the seed is a single
   * string — see the header.
   */
  audit: { targetKind: "graph.node", targetIdField: "nodeId" },
  /**
   * Verified in ontology.neighbors.ts and graph.node.get.ts: both open a scoped
   * read session and write nothing. §11.6 also states the four graph reads "are
   * read-only and scoped to the caller's workspace and resource scope".
   */
  mutates: false,

  input: z.object({
    // Carried from `get_ontology_neighbors` — the same identifier `get_node`
    // took, and the field the audit declaration above names.
    nodeId: ontologyNeighbors.input.shape.nodeId,

    /**
     * Carried by import, and the most valuable single carry in this file. The
     * describe() documents §11.6's two-layer guard: every type must match
     * `[A-Z][A-Z0-9_]{0,62}`, and when omitted the pinned schema's
     * active-vocabulary relationship types are used. Both halves are load-bearing
     * — the regex because the type is interpolated into the Cypher pattern
     * (Cypher has no parameter form for a variable-length relationship type),
     * and the default because §6.3 scopes a traversal to allowed relationship
     * types rather than to everything that happens to exist.
     */
    edgeTypes: ontologyNeighbors.input.shape.edgeTypes,

    // Carried from `get_ontology_neighbors`, default "both" — the right default
    // for "everything connected to X", which is what §11.6 says this answers.
    direction: ontologyNeighbors.input.shape.direction,

    /**
     * §11.6's hop budget. Imported from `query_ontology` rather than retyped —
     * see the header. Default 2, capped at 5.
     */
    maxDepth: ontologyQuery.input.shape.maxDepth,

    // Carried from `get_ontology_neighbors`: 1–500, default 100. §6.3 calls this
    // the node budget.
    limit: ontologyNeighbors.input.shape.limit,

    // Carried by import: the two bi-temporal axes, with the describe()s that
    // distinguish valid time from transaction time. §11.6: "`as_of` applies to
    // all four."
    asOf: ontologyNeighbors.input.shape.asOf,
    asKnownAt: ontologyNeighbors.input.shape.asKnownAt,

    /**
     * New. `get_node` always returned the property bag; `get_ontology_neighbors`
     * never did. Off by default for the traversal case: a 500-node expansion
     * with full property bags is a large response, and §11.5 rule 4's redaction
     * applies to every property that would leave the plane. A caller reading one
     * entity turns it on.
     */
    includeProperties: z.boolean().default(false),
  }),

  output: z.object({
    // Carried from `get_ontology_neighbors`: "True if the node exists in this
    // org + workspace" — the distinction between an empty neighbourhood and a
    // seed that is not there.
    found: ontologyNeighbors.output.shape.found,
    seedNodeId: z.string(),

    nodes: z.array(
      z.object({
        // Node identity carried from `get_node`, which is the source that
        // defined a node's full read shape.
        nodeId: graphNodeGet.output.shape.node.unwrap().shape.nodeId,
        label: graphNodeGet.output.shape.node.unwrap().shape.label,
        displayName: graphNodeGet.output.shape.node.unwrap().shape.displayName,
        description: graphNodeGet.output.shape.node.unwrap().shape.description,
        createdAt: graphNodeGet.output.shape.node.unwrap().shape.createdAt,
        updatedAt: graphNodeGet.output.shape.node.unwrap().shape.updatedAt,

        // Present only when `includeProperties` is set; nullable because
        // `get_node` already distinguished "no properties" from "not loaded".
        properties: graphNodeGet.output.shape.node
          .unwrap()
          .shape.properties.optional(),

        /**
         * Carried from `query_ontology`'s traversed-node shape: hop distance
         * from the seed, 0 for the seed itself. `get_ontology_neighbors` had no
         * depth because it had no depth.
         */
        depth: z
          .number()
          .int()
          .describe("Hop distance from the seed node (0 = seed)"),
      }),
    ),

    /**
     * §11.6 #3: "a subgraph as `graph` frames whose `relations[]` carry the
     * edges". Named `relations` for the spec's word. `edgeType` keeps the
     * relationship-type regex from `get_ontology_neighbors`' neighbour entry,
     * and the four bi-temporal fields are carried by import so a citation can
     * say "true as of X, recorded Y" — §11.1 stamps them, and re-declaring them
     * here is how a null upper bound stops meaning "still true".
     */
    relations: z.array(
      z.object({
        fromNodeId: z.string(),
        toNodeId: z.string(),
        edgeType:
          ontologyNeighbors.output.shape.neighbors.element.shape.edgeType,
        validFrom:
          ontologyNeighbors.output.shape.neighbors.element.shape.validFrom,
        validTo: ontologyNeighbors.output.shape.neighbors.element.shape.validTo,
        recordedAt:
          ontologyNeighbors.output.shape.neighbors.element.shape.recordedAt,
        invalidatedAt:
          ontologyNeighbors.output.shape.neighbors.element.shape.invalidatedAt,
      }),
    ),

    // Carried from `get_ontology_neighbors`: capped by `limit` with more
    // reachable. §14's rule that a badge shows the recorded value and nothing
    // stronger applies to a result set too — a truncated answer says so.
    truncated: ontologyNeighbors.output.shape.truncated,
  }),
});

export type ExpandGraphInput = z.output<typeof expandGraph.input>;
export type ExpandGraphOutput = z.output<typeof expandGraph.output>;
