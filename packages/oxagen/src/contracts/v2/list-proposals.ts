import { z } from "zod";
import { defineTool } from "./_define";
import { agentMemoryPromotionCandidates } from "../agent.memory_promotion.list";

const candidate =
  agentMemoryPromotionCandidates.output.shape.candidates.element.shape;

/**
 * Appendix E: `list_proposals`. Absorbs `list_memory_promotions`, and Appendix
 * E leaves the `Does` column empty — the v1 behaviour is broadly right.
 *
 * **What changes is that a proposal is now a thing, not a ranking.**
 * `list_memory_promotions` returned a *derived window*: the top OBSERVATIONs by
 * citation pressure, recomputed on every call, with nothing persisted. That is
 * why its sibling `dismiss_memory_promotion` had to stamp a marker on the
 * memory node — otherwise a dismissed suggestion reappeared on the next load.
 *
 * §9 makes `record_proposal` a record kind, and §10.3 gives it a lifecycle
 * (open → Context PR → checks → review → merge). So this list has real rows
 * with real statuses, and the ranking becomes an ordering over them rather than
 * their reason for existing. The citation-pressure columns carry unchanged
 * because §9 still ranks on them: "Ranking uses citation pressure and
 * confidence with decay."
 *
 * The `limit` bound is carried rather than widened even though this now backs a
 * full page (§14 page 6, Steering). Its max of 25 was tuned for the "promote
 * me" card, and paging with `offset` reaches the rest without loosening a bound
 * someone chose — `list_records` is the tool for sweeping the whole corpus.
 */
export const listProposals = defineTool({
  name: "list_proposals",
  domain: "context",
  description:
    "List the workspace's open record proposals with their proposed kind, rationale, sharing scope, citation pressure and Context PR state, ranked by the signal that made them candidates (§9).",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,

  absorbs: ["list_memory_promotions"],
  drops: [
    {
      field: "memoryKind",
      from: "list_memory_promotions",
      why: "the content-domain axis is superseded by §9's record kinds — and for a proposal the interesting kind is `proposedKind`, what it asks to become, which is carried in its place",
    },
  ],

  // Carried unchanged.
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // `agent.memory_promotion.list.ts` was read: a ranked read with no MERGE,
  // SET, CREATE or DELETE anywhere in it.
  mutates: false,

  input: z.object({
    // Carried with its bound and its default of 3 — the default is what the
    // "promote me" surface asks for, and a page asks explicitly.
    limit: agentMemoryPromotionCandidates.input.shape.limit,

    /** New, and the reason `limit`'s small ceiling is survivable. */
    offset: z.number().int().nonnegative().default(0),

    /**
     * §10.3's lifecycle, which v1 had no way to express because nothing was
     * persisted. `dismissed` is the state `dismiss_proposal` writes; `merged`
     * is the promotion event.
     */
    status: z
      .enum(["open", "pr_open", "merged", "dismissed"])
      .optional()
      .describe("Filter by proposal lifecycle status; omit for open + pr_open"),
  }),

  output: z.object({
    proposals: z.array(
      z.object({
        // Carried from the candidate row.
        id: candidate.id,
        publicId: candidate.publicId,
        statement: candidate.lesson,

        // Citation pressure, carried whole: §9 ranks on exactly these, and
        // `confidenceScore` is the half that decays.
        citationCount: candidate.citationCount,
        influenceCount: candidate.influenceCount,
        confidenceScore: candidate.confidenceScore,

        lineageId: z.string(),

        /** §9's `proposed_kind` — a directive kind or a knowledge kind. */
        proposedKind: z.enum(["directive", "fact", "assumption", "decision"]),

        /** §9: a proposal carries a rationale. Null while one is still being
         * drafted by `propose_record`. */
        rationale: z.string().nullable(),

        /** §9: "the sharing scope it asks for" — and the repo its PR targets. */
        sharingScope: z.enum(["workspace", "repository"]),

        status: z.enum(["open", "pr_open", "merged", "dismissed"]),

        /** Non-null once `open_context_pr` has run. §10.3's lifecycle is
         * legible from this list only if the PR is on it. */
        prUrl: z.string().nullable(),

        createdAt: z.string(),
      }),
    ),
  }),
});

export type ListProposalsInput = z.output<typeof listProposals.input>;
export type ListProposalsOutput = z.output<typeof listProposals.output>;
