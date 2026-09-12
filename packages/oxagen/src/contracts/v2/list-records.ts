import { z } from "zod";
import { defineTool } from "./_define";
import { contextRecordKindSchema } from "./append-record";
import { contextRecordList } from "../context.record.list";
import { agentMemoryList } from "../agent.memory.list";
import { agentMemoryCitationsList } from "../agent.memory_citation.list";
import { agentMemoryRecordSchema } from "../agent.memory.model";

const recordRow = contextRecordList.output.shape.records.element.shape;
const memoryRow = agentMemoryRecordSchema.shape;

/**
 * Appendix E: `list_records` — "by kind, scope, status, lineage". Absorbs
 * `list_context_records`, `list_memories`, `list_memory_citations` and
 * `get_citation_stats`.
 *
 * **Four readers become one because there is now one thing to read.** v1 split
 * its reads by store: `list_context_records` read the Postgres registry of
 * published records, `list_memories` read Neo4j `:AgentMemory` nodes, and the
 * two citation readers read `:Citation`. §9 makes all of them `:Record` nodes
 * in the organization's graph carrying `ws`, `kind`, `lineage_id`,
 * `record_hash`, `status` and temporal fields — so one list with a `kind`
 * filter replaces four lists with four row shapes.
 *
 * **The four filter axes in Appendix E's `Does` column are the contract.** Kind,
 * scope, status and lineage are the ones that carry; every v1 filter that
 * described the old two-axis memory model (`memoryClass`, `memoryKind`,
 * `minEnforcement`) has nothing left to filter, because `append_record` no
 * longer accepts those fields.
 *
 * **The analytics do not carry.** `get_citation_stats` returned daily series,
 * top-N rollups and least-useful-memory rankings — a dashboard, not a list. §14
 * page 6 (Steering) is defined as "Published records, proposals, open Context
 * PRs, effect metrics, and retirement candidates", so effect metrics are a
 * surface concern reading the rollup directly. Folding a dashboard into a list
 * tool would make every page of records pay for a 30-day aggregation.
 */
export const listRecords = defineTool({
  name: "list_records",
  domain: "context",
  description:
    "List the workspace's context records filtered by kind, sharing scope, lifecycle status or lineage, with citation pressure per record. One list over the §9 record graph — memories, evidence, knowledge and context-use records alike.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  // Carried from `list_context_records`: reading steering is not AI usage.
  noBillingGate: true,

  absorbs: [
    "list_context_records",
    "list_memories",
    "list_memory_citations",
    "get_citation_stats",
  ],
  renames: [
    {
      from: "executionId",
      source: "list_memory_citations",
      to: "executionRef",
      why: "carried by import; renamed to match `append_record`'s `executionRef`, which took the name from `cite_memory`. The filter that reads context_use records and the field that writes them have to spell the same thing, or a caller cannot list back what it just appended",
    },
  ],
  drops: [
    {
      field: "memoryClass",
      from: "list_memories",
      why: "the epistemic ladder is gone from the append path (see append_record): §9's record kind is the only classification a record carries, and `kind` filters on it",
    },
    {
      field: "memoryKind",
      from: "list_memories",
      why: "the content-domain axis is superseded by the protocol's kind — same collapse as on append_record",
    },
    {
      field: "minEnforcement",
      from: "list_memories",
      why: "enforcement is a property of a published directive (§10.3), and no directive is in this list — a directive reaches the graph only as a promotion_event after merge",
    },
    {
      field: "nodeRef",
      from: "list_memories",
      why: "the single-anchor field is gone with append_record's; scoping to a subject is now a graph question (`ABOUT` edges) that `search_graph`/`expand_graph` answer properly",
    },
    {
      field: "enforcementAtCite",
      from: "list_memory_citations",
      why: "follows enforcement: with no enforcement on an appended record there is no value to snapshot at cite time",
    },
    {
      field: "days",
      from: "get_citation_stats",
      why: "the whole analytics rollup moves to the Steering page's effect metrics (§14 page 6); a list must not pay for a 30-day aggregation to return a page of rows",
    },
    {
      field: "totals",
      from: "get_citation_stats",
      why: "same — cross-execution rollup, not a record list",
    },
    {
      field: "byInfluence",
      from: "get_citation_stats",
      why: "same",
    },
    {
      field: "byCompliance",
      from: "get_citation_stats",
      why: "same",
    },
    {
      field: "daily",
      from: "get_citation_stats",
      why: "same",
    },
    {
      field: "topMemories",
      from: "get_citation_stats",
      why: "same; per-record citation pressure survives as the `citationCount` column, which is what ranking needs",
    },
    {
      field: "leastUsefulMemories",
      from: "get_citation_stats",
      why: "a retirement-candidate ranking — §14 page 6 lists retirement candidates as a Steering surface concern",
    },
    {
      field: "mostViolatedRules",
      from: "get_citation_stats",
      why: "same rollup, and it ranks RULE/FACT memories, a classification this tool no longer has",
    },
    {
      field: "topNodes",
      from: "get_citation_stats",
      why: "ranks graph nodes rather than records — Appendix E gives node-level questions to `search_graph` and `query_graph`",
    },
  ],

  /**
   * All four are `{ requiresApproval: false, riskLevel: "low" }`. The category
   * is `list_context_records`' "introspection" rather than the memory
   * contracts' "memory": what this returns is now the steering corpus, not a
   * memory store.
   */
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  /**
   * The memory contracts' narrower map carries: `list_context_records` also
   * granted workspace Admin, the three memory readers did not. Taking the
   * intersection keeps the grant a deliberate addition at cutover rather than
   * something one of four sources let in.
   */
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  /**
   * All four handlers were read — `context.record.list.ts`,
   * `agent.memory.list.ts`, `agent.memory_citation.list.ts` and
   * `agent.memory_citation.stats.ts`. None contains an insert, update, MERGE or
   * SET. That is worth stating because the sibling `recall_context` reads in
   * its name too and does not get this declaration.
   */
  mutates: false,

  input: z.object({
    // The §9 kind set, shared with `append_record` so a filter can never name a
    // kind the append path cannot produce.
    kind: contextRecordKindSchema.optional(),

    /**
     * §10.2: `workspace` records live in the main repo and steer every run;
     * `repository` records live in a linked repo's own `.oxagen/rules/` and
     * steer only runs on that repo. Appendix E names scope as a filter axis and
     * no v1 contract had one.
     */
    sharingScope: z.enum(["workspace", "repository"]).optional(),

    /**
     * Widened from `list_context_records`' `active`/`retired`/`superseded`.
     * `retracted` is what `retract_record` produces, and §10.3 step 5 calls
     * retirement "a Context PR that sets `status = "archived"` in place" — so
     * the spec's own spelling replaces v1's `retired`. `superseded` stays even
     * though §9 says it is derived rather than stored: it is still a legal
     * thing to ask for, the handler just computes it.
     */
    status: z
      .enum(["active", "proposed", "superseded", "retracted", "archived"])
      .optional()
      .describe("Only return records in this lifecycle status"),

    /** §9's lineage: the chain of records that revise one idea over time.
     * Appendix E's fourth filter axis. */
    lineageId: z
      .string()
      .min(1)
      .optional()
      .describe("Return the whole revision chain for one idea"),

    // Carried from `list_memory_citations`: for context_use records, which
    // execution they belong to.
    executionRef: agentMemoryCitationsList.input.shape.executionId
      .optional()
      .describe("Scope to the records appended by one execution"),

    // Carried whole from `list_memory_citations`. Compliance and influence are
    // properties of a citation record, and filtering to VIOLATION is the
    // question the Steering page asks most.
    compliance: agentMemoryCitationsList.input.shape.compliance,
    influenceIn: agentMemoryCitationsList.input.shape.influenceIn,

    // Carried from `list_memories`: citation pressure is §9's ranking signal
    // ("Ranking uses citation pressure and confidence with decay"), so a floor
    // on it is how a caller asks for records that have proven themselves.
    minCitations: agentMemoryList.input.shape.minCitations,
    sort: agentMemoryList.input.shape.sort,
    sortDir: agentMemoryList.input.shape.sortDir,

    // Carried from `list_context_records`, whose bounds are the stricter pair
    // (max 200, default 50, and both described).
    limit: contextRecordList.input.shape.limit,
    offset: contextRecordList.input.shape.offset,
  }),

  output: z.object({
    records: z.array(
      z.object({
        // Carried from the registry row.
        id: recordRow.id,
        recordId: recordRow.recordId,
        title: recordRow.title,
        version: recordRow.version,
        checksum: recordRow.checksum,
        updatedAt: recordRow.updatedAt,

        kind: contextRecordKindSchema,
        lineageId: z.string(),
        sharingScope: z.enum(["workspace", "repository"]),
        status: z.enum([
          "active",
          "proposed",
          "superseded",
          "retracted",
          "archived",
        ]),

        // Carried from the memory record: the body, and the confidence §9
        // decays over time. `lesson`'s describe ("The memory body, human
        // readable") is the thing worth keeping attached.
        statement: memoryRow.lesson,
        confidenceScore: memoryRow.confidenceScore,

        // Citation pressure, carried from the same record shape. These three
        // counters are what `get_citation_stats` aggregated; kept per record,
        // they are the only part of it a list needs.
        citationCount: memoryRow.citationCount,
        influenceCount: memoryRow.influenceCount,
        violationCount: memoryRow.violationCount,

        createdAt: memoryRow.createdAt,
      }),
    ),

    // Carried from `list_context_records`: the count ignoring limit/offset,
    // without which a pager cannot render.
    total: contextRecordList.output.shape.total,
  }),
});

export type ListRecordsInput = z.output<typeof listRecords.input>;
export type ListRecordsOutput = z.output<typeof listRecords.output>;
