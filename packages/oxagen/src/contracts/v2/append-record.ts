import { z } from "zod";
import { defineTool } from "./_define";
import { agentMemoryWrite } from "../agent.memory.write";
import { agentMemoryRemember } from "../agent.memory.remember";
import { agentMemoryEvidenceAttach } from "../agent.memory_evidence.attach";
import { agentMemoryCite } from "../agent.memory.cite";
import { referenceCite } from "../reference.cite";

/**
 * The record kinds the exchange provider accepts from an agent, verbatim from
 * §9: `observation`, `memory`, `knowledge` (fact, assumption, decision),
 * `evidence`, `record_proposal`, `context_use`, `context_use_feedback`.
 *
 * `directive` is deliberately absent. §9: "An agent may only *propose* a
 * `directive`. It becomes active only through a Context PR (§10)." Leaving it
 * out of the enum is what makes that a schema guarantee rather than a handler
 * check — an agent cannot append a rule that steers the next run.
 * `promotion_event` is absent for the same class of reason: "The promoter
 * writes `promotion_event`, never an agent."
 *
 * Exported because `list_records` filters on the same closed set and the two
 * must not drift.
 */
export const contextRecordKindSchema = z.enum([
  "observation",
  "memory",
  "knowledge",
  "evidence",
  "record_proposal",
  "context_use",
  "context_use_feedback",
]);

/**
 * Appendix E: `append_record` — "the protocol's append". Absorbs
 * `write_memory`, `save_memory`, `attach_memory_evidence`, `cite_memory` and
 * `cite_reference`.
 *
 * **Five writers become one because §9 has one append.** Every one of the five
 * was a way of putting something into the workspace's memory graph, and each
 * invented its own shape for it. §9 replaces all five with the exchange
 * provider's `context/append` (lifecycle profile): one record, one
 * `lineage_id`, one `record_hash` that is "SHA-256 over the RFC 8785 canonical
 * bytes, with the hash member removed". The variation that survives is the
 * `kind`, and the per-kind payload hangs off it.
 *
 * **The two-axis memory model does not carry, and this is the largest judgment
 * call in the batch.** v1 had `memoryClass` (OBSERVATION → RULE → FACT) and
 * `enforcementScore` on the append itself, so an agent could write a rule with
 * enforcement 100 in one call. §9 forbids exactly that: a directive is
 * proposed, never appended, and becomes active only on a Context PR merge
 * (§10.3). The class ladder therefore moves out of the append and into
 * `propose_record` + `open_context_pr`, and what an agent appends is always an
 * observation-grade record. `memoryKind` (the content-domain axis) goes with
 * it, superseded by the protocol's `kind`.
 *
 * **Citations are records, not a side table.** `cite_memory` and
 * `cite_reference` both wrote `:Citation` nodes through their own endpoints.
 * §9's kind list has `context_use` and `context_use_feedback`, which is the
 * protocol saying a citation *is* a record. So the citation payload is carried
 * by import — whole, including its compliance semantics — and appended under
 * that kind.
 */
export const appendRecord = defineTool({
  name: "append_record",
  domain: "context",
  description:
    "Append one context record to the workspace's lineage graph — an observation, a memory, a knowledge claim, evidence, or a record of context being used. Canonically hashed per §9. An agent cannot append a directive; that is propose_record.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,

  absorbs: [
    "write_memory",
    "save_memory",
    "attach_memory_evidence",
    "cite_memory",
    "cite_reference",
  ],
  renames: [
    {
      from: "lesson",
      source: "write_memory",
      to: "statement",
      why: "§9 has one body for all seven record kinds, and a field named for a memory cannot carry an observation or a piece of evidence — neither is a 'lesson'. Carried by import, so the 1–2000 bound and its message stay attached",
    },
    {
      from: "text",
      source: "save_memory",
      to: "statement",
      why: "the same body under the second of two v1 names: `write_memory` called it `lesson`, `save_memory` called it `text`, and one append can only have one. `statement` is the spelling that fits every §9 kind",
    },
    {
      from: "source",
      source: "write_memory",
      to: "origin",
      why: "`source` meant three different things across the five absorbed contracts — provenance here, an evidence source kind on `attach_memory_evidence`, a citation's source on `cite_reference`. Appendix A's graph `Record` calls provenance `origin`, so that name wins and `source` stops being overloaded",
    },
    {
      from: "source",
      source: "save_memory",
      to: "origin",
      why: "same collapse. `save_memory`'s enum is the one carried by import because it is the superset — it adds `user` for a human-captured note",
    },
    {
      from: "relatedNodeIds",
      source: "write_memory",
      to: "aboutNodeIds",
      why: "§9 names the edge `ABOUT → :Entity`, and v1's own describe already read 'creates :ABOUT edges'. Naming the field after the edge it writes is what stops a reader guessing what 'related' meant; the 20-id cap is carried by import",
    },
    {
      from: "relatedNodeIds",
      source: "save_memory",
      to: "aboutNodeIds",
      why: "same rename, and this field now also absorbs `nodeRef` (see drops): one array holds every ABOUT edge instead of one privileged anchor plus a list",
    },
  ],
  drops: [
    {
      field: "memoryClass",
      from: "write_memory",
      why: "§9: an agent may only propose a directive, and it becomes active only through a Context PR (§10.3). Letting an append name RULE or FACT is the exact thing that rule forbids — the class ladder moves to propose_record",
    },
    {
      field: "memoryClass",
      from: "save_memory",
      why: "same, plus save_memory let a classifier *infer* the class; inferring a rule is worse than declaring one",
    },
    {
      field: "enforcementScore",
      from: "write_memory",
      why: "follows memoryClass: enforcement is policy, and §10.3's checks enforce `constraint_effect ∈ {require, forbid}` on published records — an appended record has no enforcement because it does not steer",
    },
    {
      field: "enforcementScore",
      from: "save_memory",
      why: "same",
    },
    {
      field: "memoryKind",
      from: "write_memory",
      why: "the content-domain axis (STYLE, PREFERENCE, gotcha…) is superseded by the protocol's record kind (§9); one taxonomy the protocol defines beats two that only Oxagen understands",
    },
    {
      field: "memoryKind",
      from: "save_memory",
      why: "same",
    },
    {
      field: "nodeRef",
      from: "write_memory",
      why: "§9 stores a record's subject as an `ABOUT → :Entity` edge like any other relation; a single privileged anchor field would make one of those edges special. Carried into `aboutNodeIds`",
    },
    {
      field: "nodeRef",
      from: "save_memory",
      why: "same, including its 'user-memory' default bucket — a free-form note is a record with no ABOUT edge, not a record anchored to a fake node",
    },
    {
      field: "inferred",
      from: "save_memory",
      why: "output side of the classifier: with class and kind both gone there is nothing left to infer, and §10.3's checks validate a declared kind rather than trusting a guessed one",
    },
    {
      field: "memoryId",
      from: "attach_memory_evidence",
      why: "an evidence record points at its subject through §9's `DERIVED_FROM → :Frame|:Record` edge, carried here as `derivedFrom`, rather than a foreign key that only works for memories",
    },
    {
      field: "confidenceScore",
      from: "attach_memory_evidence",
      why: "output side: §9 makes confidence a property of the lineage, recomputed from all its evidence. Returning one record's post-hoc score invites a caller to treat an append as a read of the lineage",
    },
    {
      field: "evidenceId",
      from: "attach_memory_evidence",
      why: "the evidence *is* a record now, so its identifier is the returned `recordId`",
    },
    {
      field: "runId",
      from: "cite_memory",
      why: "§9 stores which run appended a record as the `APPENDED` edge (`Run` → `Record`, with `frame_seq`), which the gateway writes from the run token — a caller-supplied run id could name someone else's run",
    },
  ],

  // All five agree: no approval, low risk, memory.
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  // `write_memory` and `save_memory` are "medium"; the three citation/evidence
  // contracts are "low". The stricter carries — an appended record is
  // free-text an agent chose to persist, and §10.3's secret and PII scan exists
  // because that text is not always safe.
  sensitivity: "medium",
  defaultEffect: "deny",
  /**
   * From `write_memory`/`save_memory`/`attach`/`cite_memory`.
   * `cite_reference` was broader (org Member, workspace Viewer) because an
   * @-mention in a chat turn is not really an authoring act. The narrower map
   * carries: an append writes to the graph that steers later runs.
   */
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // Writes :Record nodes and their lineage edges in the org's Neo4j database.
  mutates: true,

  input: z.object({
    kind: contextRecordKindSchema,

    /**
     * The record body. Carried by reference from `write_memory` — 1–2000
     * characters is the bound both memory writers learned, and §10.3's "one
     * concern per PR" rule downstream depends on records staying small enough
     * to be one concern.
     */
    statement: agentMemoryWrite.input.shape.lesson,

    /**
     * §9: "A correction is a new record on the same `lineage_id`. A lineage is
     * the chain of records that revise one idea over time." Omit to start a new
     * lineage; supply to revise an existing one. `record_id` is derived from
     * the content, so it is never an input.
     */
    lineageId: z.string().min(1).optional(),

    /**
     * Carried from `save_memory`, which had the superset of the two provenance
     * enums (it added `user` for a human-captured note). Appendix A's graph
     * `Record` has an `origin` property; this is it.
     */
    origin: agentMemoryRemember.input.shape.source,

    /**
     * §10.2: a record with `sharing_scope = "repository"` steers only runs on
     * that repo and is published to the linked repo's own `.oxagen/rules/`.
     * New — v1 memories were implicitly workspace-wide — and it has to be
     * declared at append time because it decides which repo a later Context PR
     * targets (§10.3 step 1).
     */
    sharingScope: z.enum(["workspace", "repository"]).default("workspace"),

    /**
     * Carried from `write_memory`: the `ABOUT` edges to graph entities this
     * record is about, cap included. The 20-edge ceiling is the learned part —
     * a record about twenty things is not about anything.
     */
    aboutNodeIds: agentMemoryWrite.input.shape.relatedNodeIds,

    /**
     * §9's `DERIVED_FROM → :Frame|:Record`. Replaces both
     * `attach_memory_evidence`'s `memoryId` and the implicit "this evidence is
     * about that memory" coupling, and works for a record derived from a frame
     * just as well as one derived from another record.
     */
    derivedFrom: z.array(z.string().min(1)).max(50).optional(),

    /**
     * Present when `kind` is `evidence`. Every member is carried from
     * `attach_memory_evidence`, including the 0–1 `strength` scale and the
     * `refutes` flag that makes negative evidence expressible — §9 has a
     * `CONTRADICTS` edge precisely because a corpus that can only agree with
     * itself is not evidence.
     */
    evidence: z
      .object({
        sourceKind: agentMemoryEvidenceAttach.input.shape.sourceKind,
        strength: agentMemoryEvidenceAttach.input.shape.strength,
        refutes: agentMemoryEvidenceAttach.input.shape.refutes,
        detail: agentMemoryEvidenceAttach.input.shape.detail,
      })
      .optional(),

    /**
     * Present when `kind` is `context_use` or `context_use_feedback`. Carried
     * from `cite_memory`, which merged the `:Execution` and wrote a `:Citation`
     * per memory; §9 recognises that as a record kind of its own.
     */
    executionRef: agentMemoryCite.input.shape.executionRef.optional(),
    agentId: agentMemoryCite.input.shape.agentId,
    taskSummary: agentMemoryCite.input.shape.taskSummary,

    /**
     * Carried whole, bounds and all. `deviated`, `expectedValue` and
     * `observedValue` are what let compliance be derived server-side from the
     * record's own enforcement rather than asserted by the agent that may have
     * broken it — the counterfactual that makes a citation worth recording.
     */
    citations: agentMemoryCite.input.shape.citations.optional(),

    /**
     * Carried from `cite_reference`: the @-mention path, where a human attached
     * a graph node to a turn on purpose. Kept separate from `citations` because
     * its influence is not a judgment — v1 recorded it as DECISIVE precisely
     * because someone chose it — and its 32-node cap is a different bound from
     * the citation array's 100.
     */
    references: referenceCite.input.shape.references.optional(),
  }),

  output: z.object({
    /** §9: "`record_id` is derived from the content." */
    recordId: z.string(),
    lineageId: z.string(),
    kind: contextRecordKindSchema,

    /**
     * §9: SHA-256 over the RFC 8785 canonical bytes with the hash member
     * removed, computed the same way by the protocol, Stella and Oxagen —
     * including Stella's null-stripping divergence, "so all three agree".
     * Returned so a caller can verify the append rather than trust it.
     */
    recordHash: z.string(),

    /**
     * §9 says superseded is derived, never stored, so the only statuses an
     * append can produce are the live ones. `retract_record` is what produces
     * the others.
     */
    status: z.enum(["active", "proposed"]),

    // Carried from `write_memory`: how many ABOUT edges were actually created,
    // which is not the length of `aboutNodeIds` when an id names nothing.
    edgesCreated: agentMemoryWrite.output.shape.edgesCreated,

    /**
     * Present only for a citation append. Carried whole from `cite_memory`,
     * including the per-citation `ok`/`error` pair: one bad memory id in a
     * hundred must not fail the other ninety-nine, and the caller needs to know
     * which one it was.
     */
    citations: agentMemoryCite.output.shape.results.optional(),
    recorded: agentMemoryCite.output.shape.recorded.optional(),
  }),
});

export type AppendRecordInput = z.output<typeof appendRecord.input>;
export type AppendRecordOutput = z.output<typeof appendRecord.output>;
