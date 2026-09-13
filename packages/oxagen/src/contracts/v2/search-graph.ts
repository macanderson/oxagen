import { z } from "zod";
import { defineTool } from "./_define";
import { graphSearch } from "../graph.search";
import { graphNodeSearch } from "../graph.node.search";
import { referenceSearch } from "../reference.search";
import { graphNodeList } from "../graph.node.list";
import { ontologyQuery } from "../ontology.query";

/**
 * Appendix E: `search_graph` — "hybrid semantic". Absorbs `search_graph`,
 * `search_nodes`, `search_references` and `list_nodes`.
 *
 * §11.6 #2 defines it as "the hybrid semantic retrieval of §11.5, with filters
 * by label, property, time (`as_of`), and repository", and §11.5 defines
 * *hybrid*: a vector search and a BM25 full-text search over the allowed labels,
 * fused by reciprocal rank, reranked with `rerank-2.5` over the top 50, and
 * returned as context frames with citations.
 *
 * That single pipeline is why four contracts collapse. v1 made the caller pick
 * the retrieval strategy: `search_graph` was vector-only, `search_nodes` was
 * fuzzy string matching on displayName/description, `list_nodes` was a filtered
 * browse, and `search_references` was typed autocomplete over platform objects.
 * A caller who picked wrong got no results and no way to know why. In v2 the
 * strategy is the product's, not the caller's — the caller brings a query and
 * filters, and the fusion decides.
 *
 * Two carries to check:
 *
 * - **The 1–50 limit wins over `list_nodes`' 1–250.** §11.5 reranks the top 50
 *   candidates; a 250-row page would return 200 rows the reranker never scored,
 *   graded on the same `score` field as the 50 it did. One cap, and it is the
 *   one the pipeline can actually honour.
 * - **`asOf` is imported from `query_ontology`, which this tool does not
 *   absorb.** §11.6 is explicit: "`as_of` applies to all four" graph reads. None
 *   of the four sources here had it, so rather than retype a `.datetime()`
 *   string this takes the shared bi-temporal field the sibling graph reads
 *   already use, so the two axes keep their one documented meaning.
 */
export const searchGraph = defineTool({
  name: "search_graph",
  domain: "graph",
  description:
    "Hybrid semantic search over the workspace graph: vector and full-text retrieval fused by reciprocal rank, reranked, and returned as cited context frames. Filters by label, reference kind, source and valid time.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["search_graph", "search_nodes", "search_references", "list_nodes"],
  drops: [
    {
      field: "query",
      from: "search_nodes",
      why: "input; the same field, carried once from `search_graph` whose 1000-char bound is the wider of the two. §11.5 embeds the query text, and a 500-char cap would truncate the natural-language questions the pipeline is built for",
    },
    {
      field: "limit",
      from: "list_nodes",
      why: "input; `list_nodes` allowed 250 per page. §11.5 reranks the top 50 candidates, so anything past 50 would carry a `score` no reranker produced. `search_graph`'s 1–50 cap carries instead",
    },
    {
      field: "properties",
      from: "list_nodes",
      why: "output; a search result is a citation, not a node read — §11.6 #3 (`expand_graph`) is where a node's property bag comes from. Returning the full bag for 50 candidates also defeats §11.5 rule 4, which strips sensitive values before text reaches a model",
    },
    {
      field: "createdAt",
      from: "list_nodes",
      why: "output; superseded by the bi-temporal fields — §11.1 stamps every node with valid_from/valid_to/recorded_at, and a row-creation timestamp next to those is the one a reader will misuse",
    },
    {
      field: "limit",
      from: "list_nodes",
      why: "output; the echoed page size. The caller supplied it, and `hasMore` is what actually drives a next page",
    },
    {
      field: "offset",
      from: "list_nodes",
      why: "output; echo, as `limit`",
    },
    {
      field: "kind",
      from: "search_graph",
      why: 'output; v1\'s `z.literal("entity")` could only ever say one thing. §11.5 gives a frame a kind by label — fact, memory, doc, symbol, episode — so the literal is replaced by that enum. The spec is richer than the code here, not stricter',
    },
  ],

  // All four sources are low sensitivity, low risk, no approval, and every one
  // declares mutates: false. Nothing to reconcile.
  agent: { requiresApproval: false, riskLevel: "low", category: "graph" },
  sensitivity: "low",
  defaultEffect: "deny",
  /**
   * `search_graph`, `search_nodes` and `search_references` allow workspace
   * Viewer; `list_nodes` allows Owner/Member only. The stricter carries, so
   * **Viewer does not** — the same call made in `get_ontology` and
   * `list_sources`, and flagged for the same reason: it is the one place in this
   * batch where taking the stricter source visibly narrows who can use the
   * Ontology page. §6.3's resource scopes (allowed labels, hop and node budgets)
   * are the intended mechanism for a read-only role, not a wider default here.
   */
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  /**
   * Verified in the handlers, not inferred: graph.search.ts,
   * graph.node.search.ts, reference.search.ts and graph.node.list.ts all read
   * and write nothing. The embedding call §11.5 makes for the query is a model
   * call recorded as a frame by the recorder, not a write this tool performs.
   */
  mutates: false,

  input: z.object({
    /**
     * Carried from `search_graph` — the widest bound of the four, with the
     * describe() that says the text is embedded. §11.6 notes questions are
     * untrusted text; nothing here reaches a query language, only an embedder
     * and a full-text index.
     */
    query: graphSearch.input.shape.query,

    // Carried from `search_graph`, with its example. §11.5 runs both retrievals
    // "over the allowed labels", so this narrows the candidate set before fusion.
    labels: graphSearch.input.shape.labels,

    // Carried from `search_graph`: 1–50, default 10 — the reranker's window.
    limit: graphSearch.input.shape.limit,

    /**
     * Carried from `search_references`: the ten referenceable kinds
     * (repository, branch, file, directory, agent, tool, mcp_server, capability,
     * node, edge). The array's own comment is load-bearing — this list must stay
     * in lockstep with `MentionType` in @oxagen/ai/mentions, which a unit test
     * asserts, so it is imported rather than restated.
     */
    types: referenceSearch.input.shape.types,

    /**
     * Carried from `search_references`: exact public-id resolve mode, used to
     * rehydrate a mention chip that was inserted earlier. Ignores `query`, as
     * its describe() says.
     */
    slug: referenceSearch.input.shape.slug,

    /**
     * Carried from `list_nodes`. §11.6 #2 lists "repository" among the filters,
     * and a repository is a source connector in §11.1's Source layer — this is
     * that filter.
     */
    sourceId: graphNodeList.input.shape.sourceId,

    /**
     * §11.6: "`as_of` applies to all four, using the node and edge temporal
     * fields. So 'what did we know about this account in June' is a query, not
     * an export." Imported from `query_ontology`'s shared bi-temporal fields —
     * see the header for why this import crosses tools.
     */
    asOf: ontologyQuery.input.shape.asOf,
    asKnownAt: ontologyQuery.input.shape.asKnownAt,

    // Carried from `list_nodes` for the browse case — the Graph tab's explorer
    // pages through a label with an empty query.
    offset: graphNodeList.input.shape.offset,
  }),

  output: z.object({
    results: z.array(
      z.object({
        // Carried from `search_graph`'s result row.
        nodeId: graphSearch.output.shape.results.element.shape.nodeId,
        label: graphSearch.output.shape.results.element.shape.label,
        displayName: graphSearch.output.shape.results.element.shape.displayName,
        snippet: graphSearch.output.shape.results.element.shape.snippet,
        score: graphSearch.output.shape.results.element.shape.score,

        // Carried from `search_nodes`, which is the source that returned a
        // node's description alongside its name.
        description:
          graphNodeSearch.output.shape.nodes.element.shape.description,

        /**
         * §11.5: "Each frame has a kind by label (`fact` for entities and
         * knowledge records, `memory` for memory records, `doc` for chunks,
         * `symbol` for code, `episode` for run summaries)." Replaces
         * `search_graph`'s `z.literal("entity")`, which predates the code graph
         * and the context records both being searchable.
         */
        kind: z.enum(["fact", "memory", "doc", "symbol", "episode", "graph"]),

        /**
         * Carried from `search_references`: what makes a non-node result — a
         * repository, a file, an agent, a capability — usable as a mention
         * token. `type` is null for plain graph nodes, which have `label`
         * instead.
         */
        type: referenceSearch.output.shape.results.element.shape.type.nullable(),
        slug: referenceSearch.output.shape.results.element.shape.slug.nullable(),
        location:
          referenceSearch.output.shape.results.element.shape.location.nullable(),

        /**
         * §11.5: "Each frame also carries provenance to the node, its source
         * record and digest, temporal validity from the node, a score normalized
         * into the protocol's provider-local range, and the exact token cost."
         * New — none of the four sources cited anything, which is why §14's rule
         * that every explanation is a chain of links could not be met by them.
         */
        provenance: z.object({
          sourceRecordId: z.string().nullable(),
          digest: z.string().nullable(),
          connectorId: z.string().nullable(),
          validFrom: z.string().nullable(),
          validTo: z.string().nullable(),
        }),
      }),
    ),

    // Carried from `list_nodes` for the browse case.
    total: graphNodeList.output.shape.total,
    hasMore: graphNodeList.output.shape.hasMore,
  }),
});

export type SearchGraphInput = z.output<typeof searchGraph.input>;
export type SearchGraphOutput = z.output<typeof searchGraph.output>;
