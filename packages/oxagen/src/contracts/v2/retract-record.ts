import { z } from "zod";
import { defineTool } from "./_define";
import { agentMemoryDemote } from "../agent.memory.demote";

/**
 * Appendix E: `retract_record` — "new record on the lineage". Absorbs
 * `delete_memory` and `demote_memory`.
 *
 * **Appendix E's `Does` column is the whole design, and it inverts both
 * sources.** `delete_memory` was a hard `DETACH DELETE`: "the node and its
 * REMEMBERS/ABOUT edges are gone". `demote_memory` mutated a node's class in
 * place. Neither survives contact with §9 and §10.3:
 *
 *   - §9: "A correction is a new record on the same `lineage_id`. Superseded is
 *     derived, never stored." A retraction is therefore an *append*, not an
 *     edit, and the record it retracts stays exactly as it was.
 *   - §10.3 step 5: "Retirement is a Context PR that sets `status = "archived"`
 *     in place. Files are never deleted."
 *
 * So this tool writes a new record carrying a `SUPERSEDES` edge, and the thing
 * being retracted keeps its hash, its evidence and its citation history. That
 * is not bookkeeping pedantry: a run that cited a record must stay explainable
 * after the record is withdrawn, and a deleted node makes that impossible.
 *
 * **Publishing the retraction is a different call.** This is the graph half. If
 * the retracted record was published to `.oxagen/rules/`, the archive has to go
 * through a Context PR (§10.3 step 5) — that is `open_context_pr`, and the
 * `promotion_event` lands on merge.
 *
 * Nothing is imported from `delete_memory`: every field it had is in `drops`,
 * which is the honest outcome when a source's entire shape was built around an
 * operation the spec forbids.
 */
export const retractRecord = defineTool({
  name: "retract_record",
  domain: "context",
  description:
    "Withdraw a context record by appending a retraction to its lineage. The original record is never deleted or edited — it keeps its hash, evidence and citations, and the retraction supersedes it (§9). Publishing the retirement of a published record is open_context_pr.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: ["delete_memory", "demote_memory"],
  drops: [
    {
      field: "memoryId",
      from: "delete_memory",
      why: "the id space changed with the store: §9 stores context as `:Record` nodes with a content-derived `record_id`, not `:AgentMemory` nodes addressed by an internal node id. Carried as `recordId`, retyped rather than imported because v1's describe ('The AgentMemory node id (not publicId)') would have been carried in as a lie",
    },
    {
      field: "memoryId",
      from: "demote_memory",
      why: "same",
    },
    {
      field: "deleted",
      from: "delete_memory",
      why: "output side of the inversion: nothing is deleted, so there is no deletion to report. The answer is the retraction record's own id",
    },
    {
      field: "toClass",
      from: "demote_memory",
      why: "the FACT → RULE → OBSERVATION ladder is gone from the graph (see append_record): a record's force is its kind and its published status, and lowering a published directive's force is a Context PR, not an in-place edit (§10.3)",
    },
    {
      field: "enforcementScore",
      from: "demote_memory",
      why: "follows toClass — enforcement only existed to grade a RULE",
    },
    {
      field: "confirmedByKind / confirmedById",
      from: "demote_memory",
      why: "v1 cleared human confirmation when leaving FACT. With no class ladder there is nothing to unconfirm; §10.3's review modes are where a human's accountability is recorded now",
    },
    {
      field: "(the returned memory record)",
      from: "demote_memory",
      why: "v1 returned the mutated node. Nothing is mutated, so the output describes the new retraction record instead — returning the old record would imply it had changed",
    },
  ],

  // Both sources agree exactly, and the approval is the part worth keeping:
  // withdrawing something the workspace learned is not a low-stakes edit.
  agent: { requiresApproval: true, riskLevel: "medium", category: "memory" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // Appends a :Record with SUPERSEDES/CONTRADICTS edges. It writes nothing to
  // the retracted record itself, but it is a write.
  mutates: true,

  input: z.object({
    /**
     * The record being withdrawn. Fresh rather than carried: both sources'
     * ids named an `:AgentMemory` node, and carrying the schema would have
     * carried a description that is now wrong. Everything else here is by
     * import.
     */
    recordId: z.string().min(1).describe("The §9 record_id being retracted"),

    /**
     * Two different acts, and conflating them loses the reason. `retracted`
     * says the statement was wrong — it should never have steered anything, and
     * runs that cited it are suspect. `archived` (§10.3 step 5's own word) says
     * it was right and is no longer in force.
     */
    disposition: z
      .enum(["retracted", "archived"])
      .describe(
        "retracted: the statement was wrong. archived: it was right and no longer applies (§10.3 step 5)",
      ),

    // Carried from `demote_memory`, bounds included. Optional there; kept
    // optional here so a bulk archive is not blocked on prose, though §10.3's
    // PR body will want one for anything published.
    rationale: agentMemoryDemote.input.shape.rationale,

    /**
     * §9's `SUPERSEDES` edge, pointed forward. When a retraction exists because
     * a better record replaced it, naming the replacement is what lets the
     * lineage be read as a revision chain rather than a gap.
     */
    supersededBy: z
      .string()
      .min(1)
      .optional()
      .describe("The record_id that replaces this one, when one does"),
  }),

  output: z.object({
    /** The retraction record — a new node on the lineage, per Appendix E. */
    recordId: z.string(),
    lineageId: z.string(),
    recordHash: z.string(),

    /** The record this retraction supersedes; unchanged by the call. */
    retractedRecordId: z.string(),

    disposition: z.enum(["retracted", "archived"]),

    /**
     * True when the retracted record was published to `.oxagen/rules/` and the
     * retirement therefore still needs a Context PR to take effect (§10.3 step
     * 5). Without this the caller cannot tell a finished withdrawal from one
     * that is still steering every run.
     */
    requiresContextPr: z.boolean(),
  }),
});

export type RetractRecordInput = z.output<typeof retractRecord.input>;
export type RetractRecordOutput = z.output<typeof retractRecord.output>;
