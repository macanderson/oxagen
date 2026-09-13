import { z } from "zod";
import { defineTool } from "./_define";
import { agentMemoryRecall } from "../agent.memory.recall";

const recalled = agentMemoryRecall.output.shape.memories.element.shape;

/**
 * Appendix E: `recall_context` — "the provider's query, as a tool for agents".
 * Absorbs `recall_memory`.
 *
 * **This is the exchange provider's `context/query`, not a memory search.**
 * §11.9: "Oxagen exposes one provider per workspace on the tool gateway host.
 * The provider offers `context/query` over entities, records, and runs, with
 * kinds `fact`, `doc`, `memory`, `episode`, and `graph`." So the `kinds`
 * parameter is the protocol's, and `memory` is one of five rather than the only
 * thing there is to recall. That single change is most of the carry: v1 could
 * answer "what do I remember about X"; v2 has to answer "what context is there
 * about X", which is a superset that includes ingested documents and prior
 * runs.
 *
 * **`mutates` is deliberately absent, and this contract is why the rule
 * exists.** `recall_memory` reads in its name, is classified `sensitivity:
 * "low"`, and its handler writes: a fire-and-forget `insertMemoryChange` per
 * recalled row, and — when `executionRef` is passed — a MERGEd `:Execution`
 * plus a CONSIDERED `:Citation` for every result, including
 * `citation_count = coalesce(citation_count, 0) + 1`, a read-modify-write that
 * loses updates when two recalls interleave. That citation pressure is not
 * incidental; §9 says ranking uses it and it is what surfaces promotion
 * candidates to `list_proposals`. So the write is load-bearing and the field
 * stays off.
 */
export const recallContext = defineTool({
  name: "recall_context",
  domain: "context",
  description:
    "Query the workspace's context provider by semantic similarity across records, documents, entities, episodes and graph neighbourhoods (§11.9). Results carry provenance and token cost. Pass executionRef to record the recall as citation pressure.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["recall_memory"],
  drops: [
    {
      field: "memoryClass",
      from: "recall_memory",
      why: "the OBSERVATION/RULE/FACT ladder is gone from the append path (see append_record), so there is no class to filter on; §11.9's five provider kinds replace it as the axis a caller actually wants",
    },
    {
      field: "minEnforcement",
      from: "recall_memory",
      why: "follows memoryClass — enforcement grades a published directive, and published steering reaches a run as a compiled context frame (§10.2), not through a recall filter",
    },
    {
      field: "nodeRef",
      from: "recall_memory",
      why: "the single-anchor field is gone with append_record's; a subject-scoped question is `expand_graph` (typed traversal from a node), which answers it properly instead of approximating it with a filter",
    },
    {
      field: "memoryKind",
      from: "recall_memory",
      why: "output side: the content-domain axis is superseded by the protocol's frame `kind`, which is carried",
    },
    {
      field: "source",
      from: "recall_memory",
      why: "the free-text provenance string is replaced by the structured `provenance` block §11.9 requires — 'Frames carry provenance to the entity, source record, connector, and digest'",
    },
    {
      field: "enforcementScore",
      from: "recall_memory",
      why: "follows minEnforcement",
    },
  ],

  // Carried unchanged from the single source.
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // `mutates` intentionally omitted — see the doc comment. Absent means it
  // mutates, which is the truth here.

  input: z.object({
    // Carried by reference.
    query: agentMemoryRecall.input.shape.query,

    /**
     * §11.9's five provider kinds. New — v1 had only memories to search — and
     * plural because a useful recall usually wants a document and a prior
     * episode alongside what the workspace remembers.
     */
    kinds: z
      .array(z.enum(["fact", "doc", "memory", "episode", "graph"]))
      .nonempty()
      .optional()
      .describe("Restrict to these provider kinds; omit to query all five"),

    // Carried with its bounds: max 50, default 10. The ceiling matters because
    // every returned frame is tokens in someone's context window.
    limit: agentMemoryRecall.input.shape.limit,

    /**
     * Carried verbatim, describe included, because it is the field that makes
     * this tool a write. Omitting it is a pure read; passing it records an
     * `:Execution` and a CONSIDERED citation per result, which is the citation
     * pressure §9 ranks on and `list_proposals` surfaces.
     */
    executionRef: agentMemoryRecall.input.shape.executionRef,
    agentId: agentMemoryRecall.input.shape.agentId,
  }),

  output: z.object({
    frames: z.array(
      z.object({
        // Carried from the recall row.
        id: recalled.id,
        statement: recalled.lesson,
        score: recalled.score,
        confidenceScore: recalled.confidenceScore,
        createdAt: recalled.createdAt,

        /** Which of §11.9's five kinds this frame came from. */
        kind: z.enum(["fact", "doc", "memory", "episode", "graph"]),

        /**
         * §11.9: "Frames carry provenance to the entity, source record,
         * connector, and digest." Every member is nullable because a frame from
         * an appended record has no connector, and one from a connector has no
         * source record — the shape describes all five kinds or it describes
         * none of them.
         */
        provenance: z.object({
          entityId: z.string().nullable(),
          sourceRecordId: z.string().nullable(),
          connectorId: z.string().nullable(),
          digest: z.string().nullable(),
        }),

        /**
         * §11.9: "`token_cost` is the protocol's exact accounting." Returned
         * per frame so a caller can trim the recall to a budget before it
         * reaches a model, rather than discovering the cost in §12.6's
         * measurement afterwards.
         */
        tokenCost: z.number().int().nonnegative(),

        /**
         * §11.9: "`valid_from`/`valid_to` come from the entity's temporal
         * fields." Null `validTo` means still current — the distinction a
         * recall needs to stop returning last quarter's answer as this
         * quarter's.
         */
        validFrom: z.string().nullable(),
        validTo: z.string().nullable(),
      }),
    ),
  }),
});

export type RecallContextInput = z.output<typeof recallContext.input>;
export type RecallContextOutput = z.output<typeof recallContext.output>;
