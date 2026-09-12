import { z } from "zod";
import { defineTool } from "./_define";
import { agentMemoryPromote } from "../agent.memory.promote";
import { agentMemoryPromotionRationales } from "../agent.memory_promotion.rationales";
import { contextRecordPromote } from "../context.record.promote";

/**
 * Appendix E: `propose_record` — "a proposal". Absorbs `promote_memory`,
 * `promote_context_record` and `suggest_promotion_rationales`.
 *
 * **A proposal is a record, and it changes nothing.** §9 defines the shape
 * directly: "A proposal carries `proposed_kind` (a directive kind or knowledge
 * kind), a rationale, the supporting record ids, and the sharing scope it asks
 * for." Those four are the input, near enough verbatim. Both v1 promote
 * contracts *applied* a change — `promote_memory` moved a node up the class
 * ladder, `promote_context_record` appended a lifecycle action to the
 * hash-chained ledger and pinned a version — and neither can carry, because §9
 * is explicit that "The promoter writes `promotion_event`, never an agent" and
 * §10.3 makes merge the promotion event. Proposing and promoting are now two
 * different moments with a human review between them.
 *
 * **The rationale drafter folds in rather than being called first.**
 * `suggest_promotion_rationales` existed to save a human typing. Making it a
 * separate call meant the draft and the proposal could disagree; here, omitting
 * `rationale` asks for `rationaleCount` drafts back on the proposal itself, and
 * the human picks one before the Context PR is opened.
 *
 * **What carries from `promote_context_record` is its governance discipline.**
 * `policyVersion` is taken by import: §6 requires every decision to cite the
 * policy version it was taken under, and a proposal opened under one policy and
 * merged under another is exactly the case that needs it recorded at the start.
 */
export const proposeRecord = defineTool({
  name: "propose_record",
  domain: "context",
  description:
    "Open a proposal on a lineage: what kind of record it should become, why, which records support it, and the sharing scope it asks for (§9). Proposes only — promotion happens when the Context PR merges (§10.3). Drafts candidate rationales when none is given.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: [
    "promote_memory",
    "promote_context_record",
    "suggest_promotion_rationales",
  ],
  renames: [
    {
      from: "policy_version",
      source: "promote_context_record",
      to: "policyVersion",
      why: "carried by import (`contextRecordPromote.input.shape.policy_version`); only the spelling changes, to the camelCase every other v2 field uses per ADR-025. §6's 'every decision cites the policy version' is untouched",
    },
    {
      from: "basedOnEvidenceIds",
      source: "promote_memory",
      to: "supportingRecordIds",
      why: "§9 calls them 'the supporting record ids', and the widening is real: a proposal may cite any supporting record, not only an evidence node. Carried by import, so the 50-id cap and the `:BASED_ON` edge semantics travel with the field",
    },
    {
      from: "count",
      source: "suggest_promotion_rationales",
      to: "rationaleCount",
      why: "`count` was unambiguous on a standalone drafter; on a proposal that also carries supporting records and threshold results it is not. Carried by import with its 2–6 bound and its default of 4",
    },
  ],
  drops: [
    {
      field: "memoryId",
      from: "promote_memory",
      why: "a proposal is about an idea, not a node: §9 aggregates 'records across runs by lineage and by entity', so the subject is the lineage and the individual records that support it go in supportingRecordIds",
    },
    {
      field: "toClass",
      from: "promote_memory",
      why: "the RULE/FACT ladder is replaced by §9's `proposed_kind` (a directive kind or knowledge kind), which is the protocol's vocabulary rather than Oxagen's",
    },
    {
      field: "enforcementScore",
      from: "promote_memory",
      why: "enforcement belongs to the published record's steering block in the TOML file (§10.2), written in the Context PR and validated by §10.3's checks — not asserted when the proposal opens",
    },
    {
      field: "(the returned memory record)",
      from: "promote_memory",
      why: "v1 returned the promoted node because it had mutated it. A proposal mutates nothing it proposes on — §9: 'The promoter writes promotion_event, never an agent'",
    },
    {
      field: "action",
      from: "promote_context_record",
      why: "the promote/retire/supersede lifecycle verb splits by destination: promote is this tool plus a merge, and retire/supersede are `retract_record`. One enum could not carry when the three actions stopped sharing a code path",
    },
    {
      field: "version_id",
      from: "promote_context_record",
      why: "pinning a version active is what merge does (§10.3 step 4); a proposal names no version because the version it proposes does not exist until the PR is opened",
    },
    {
      field: "record_id",
      from: "promote_context_record",
      why: "carried as `lineageId` — §10.2 publishes one record per lineage id, so the lineage is the stable key and the file stem is derived from it",
    },
    {
      field: "seq",
      from: "promote_context_record",
      why: "output side: the hash-chained promotions ledger entry is appended at merge (§10.3 step 3, 'A promotions.jsonl entry is appended in the same merge'), so a proposal has no position in the chain yet",
    },
    {
      field: "chainDigest",
      from: "promote_context_record",
      why: "follows seq — there is no ledger row to digest until the PR merges",
    },
    {
      field: "status",
      from: "promote_context_record",
      why: "the record's lifecycle status after the action. Nothing is applied here, so the record's status is unchanged and reporting it would imply otherwise",
    },
    {
      field: "toClass",
      from: "suggest_promotion_rationales",
      why: "the drafter took the class change being considered; it now takes `proposedKind` from the proposal it is drafting for, so the draft and the proposal cannot describe different changes",
    },
    {
      field: "memoryId",
      from: "suggest_promotion_rationales",
      why: "same collapse into the lineage as promote_memory's",
    },
  ],

  /**
   * The strictest across the three, and the two axes come from different
   * sources: `requiresApproval: true` and `riskLevel: "high"` from
   * `promote_context_record` (governance — it wrote the hash-chained ledger),
   * against `promote_memory`'s `medium` and `suggest_promotion_rationales`'
   * `{ false, low }`. Category follows the risk to `governance`.
   */
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  // From `promote_context_record`. A proposal is the first step of the only
  // path by which anything ever steers a run.
  sensitivity: "high",
  defaultEffect: "deny",
  /**
   * `promote_context_record`'s map is the stricter on the workspace side
   * (Owner/Admin against `promote_memory`'s Owner/Member), and the intersection
   * of the two is workspace Owner alone.
   */
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  /**
   * `noBillingGate` is NOT carried from `promote_context_record`, which set it
   * true. Drafting rationales calls a model on the `complex` tier (§8 lists
   * "promotion rationale" there by name) and metered token spend must stay
   * behind the admission gate. A proposal that supplies its own `rationale`
   * spends nothing, but the gate cannot be conditional on a field.
   */
  // Writes a :Record of kind record_proposal with PROPOSES and BASED_ON edges.
  mutates: true,

  input: z.object({
    /**
     * The idea being proposed on. §9: proposals are aggregated "by lineage and
     * by entity", and §10.2 publishes one record per lineage id, so this is the
     * key both ends agree on.
     */
    lineageId: z.string().min(1).describe("The lineage this proposal is about"),

    /**
     * §9's `proposed_kind`: "a directive kind or knowledge kind". `directive`
     * appears here and nowhere in `append_record`'s enum, which is the whole
     * point — §9 allows an agent to propose one and forbids it appending one.
     */
    proposedKind: z
      .enum(["directive", "fact", "assumption", "decision"])
      .describe("What this lineage should become if the Context PR merges"),

    /**
     * §9's rationale. Carried from `promote_memory` with its 1–1000 bound.
     * Omit it to have `rationaleCount` candidates drafted instead — §10.3 step
     * 1 requires the PR body to carry a rationale, so one has to exist before
     * the PR is opened either way.
     */
    rationale: agentMemoryPromote.input.shape.rationale,

    /**
     * Carried from `suggest_promotion_rationales` with its 2–6 bound and
     * default of 4. Only consulted when `rationale` is absent.
     */
    rationaleCount: agentMemoryPromotionRationales.input.shape.count,

    /**
     * §9's "supporting record ids". Carried from `promote_memory`'s
     * `basedOnEvidenceIds`, whose 50-id cap and `:BASED_ON` edge semantics are
     * exactly right — widened in meaning from evidence nodes to any supporting
     * record, because §9 says a proposal cites records.
     */
    supportingRecordIds: agentMemoryPromote.input.shape.basedOnEvidenceIds,

    /**
     * §9's "the sharing scope it asks for", and it is not cosmetic: §10.3 step
     * 1 picks the PR's target repo from it — the main repo for workspace-scoped
     * records, the linked repo for repository-scoped ones.
     */
    sharingScope: z
      .enum(["workspace", "repository"])
      .describe("Decides which repo the Context PR targets (§10.3 step 1)"),

    /**
     * Carried by import from `promote_context_record`. §6: "Every decision
     * cites the policy version." A proposal that sat for a week and merged
     * under a newer policy has to record which policy it was opened under, or
     * the audit cannot reconstruct the thresholds it met.
     */
    policyVersion: contextRecordPromote.input.shape.policy_version,
  }),

  output: z.object({
    /** The `record_proposal` record this call appended (§9's kind list). */
    proposalRecordId: z.string(),
    lineageId: z.string(),
    proposedKind: z.enum(["directive", "fact", "assumption", "decision"]),
    sharingScope: z.enum(["workspace", "repository"]),

    /**
     * Carried from `suggest_promotion_rationales`, bounds included. Empty when
     * the caller supplied a rationale. The array is ordered most-fitting-first
     * and is a draft, never a commitment — the human picks one before
     * `open_context_pr`.
     */
    suggestedRationales:
      agentMemoryPromotionRationales.output.shape.rationales.optional(),

    /**
     * §9 lists the promoter's thresholds — "support across at least N runs and
     * M distinct agents, confidence above a floor, no active contradiction, and
     * no open proposal on the lineage" — and says they "belong to the product,
     * not the protocol". A proposal that fails them is still recorded, so the
     * caller needs to be told which one it failed rather than getting an error.
     */
    thresholds: z.object({
      met: z.boolean(),
      unmet: z
        .array(
          z.enum([
            "run_support",
            "agent_support",
            "confidence_floor",
            "active_contradiction",
            "open_proposal_on_lineage",
          ]),
        )
        .default([]),
    }),
  }),
});

export type ProposeRecordInput = z.output<typeof proposeRecord.input>;
export type ProposeRecordOutput = z.output<typeof proposeRecord.output>;
