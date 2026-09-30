// open_context_pr — the pull request that publishes a proposal (ADR-061; MC
// spec §10.3 step 1-2): a branch from the production branch of the
// workspace's repository, the single record file, the PR with its body, then
// the six §10.3 checks one at a time, each mirrored as a GitHub check run or a
// GitLab commit status. The branch and file follow the repository's layout
// (#4731). A legacy repository gets `.oxagen/rules/<lineage>.toml` on
// `steering/<lineage>`. A steering repository gets a steering record at
// `steering/<kind folder>/<lineage>.md` on `steering/<lineage>`, or a memory
// at `steering/memory/workspace/general/<lineage>.md` on `memory/<lineage>`.
// A revision is written where the record lives now. On a GitLab main project
// the PR is a merge request (#3762). Calling it again on a proposal
// whose PR is open re-runs the checks on the same PR: one concern, one pull
// request. The handler gates on the caller's org or workspace role, which
// only a signed-in user holds; an API key carries no user, so the MCP and CLI
// surfaces (API-key auth) are not declared.
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  checkResultSchema,
  constraintEffectSchema,
  governanceModeSchema,
  proposalKindSchema,
  proposalStatusSchema,
  publishedSharingScopeSchema,
  recordForceSchema,
  recordKindSchema,
  repositoryProviderSchema,
} from "./context.steering.shared";

const instant = z.string().datetime({ offset: true });

/** The Context PR as the page renders it: the state machine and its evidence. */
export const contextPrSchema = z
  .object({
    proposalId: z.string(),
    lineageId: z.string(),
    /**
     * A record kind, or `governance` for a change to the governance mode
     * (#4795). A governance PR runs no record checks again and never merges
     * without review, so a surface offers neither.
     */
    kind: proposalKindSchema,
    status: proposalStatusSchema,
    /** Read from governance.toml when the PR opens; null before. */
    governanceMode: governanceModeSchema.nullable(),
    pr: z
      .object({
        number: z.number().int().positive(),
        url: z.string(),
        /**
         * The host the PR lives on. On GitLab it is a merge request and
         * `number` is its IID, which is scoped to the project.
         */
        provider: repositoryProviderSchema,
        repository: z.string(),
        baseRef: z.string(),
        branch: z.string(),
        headSha: z.string().nullable(),
        path: z.string(),
      })
      .strict()
      .nullable(),
    /** The record as stamped into the file; null before the PR is opened. */
    record: z
      .object({
        recordId: z.string(),
        recordHash: z.string(),
        kind: recordKindSchema,
        force: recordForceSchema,
        constraintEffect: constraintEffectSchema.nullable(),
        sharingScope: publishedSharingScopeSchema,
        statement: z.string(),
      })
      .strict()
      .nullable(),
    /** The PR body as opened. */
    body: z.string().nullable(),
    checks: z.array(checkResultSchema),
    /** What merge will do (spec §10.3 step 4), from the record and the ledger. */
    onMerge: z
      .object({
        publishes: z
          .object({ lineageId: z.string(), path: z.string() })
          .strict(),
        /**
         * The promotions ledger length now and after merge, one entry per
         * merged record. It is not the steering version, which
         * merge_context_pr answers as `publishedVersion` (#4732).
         */
        bundleVersion: z
          .object({ current: z.number().int(), afterMerge: z.number().int() })
          .strict(),
        /** Who may merge under the governance mode, and the separation rule; null until the mode is read. */
        review: z.string().nullable(),
      })
      .strict(),
    merged: z
      .object({
        commit: z.string(),
        at: instant,
        byUserId: z.string().nullable(),
        /** Null for a governance proposal, which appends no promotion event (#4795). */
        promotionEventId: z.string().nullable(),
        /** Null for a governance proposal, which publishes no record. */
        recordId: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ContextPr = z.infer<typeof contextPrSchema>;

export const contextPrOpen = registerCapability({
  name: "open_context_pr",
  domain: "context",
  description:
    "Open the Context PR for a proposal: a branch from the production branch, the single record file, the PR body with rationale, supporting records and evidence, then the six checks one at a time as GitHub check runs or GitLab commit statuses. In a legacy repository the file is .oxagen/rules/<lineage>.toml on steering/<lineage>. In a steering repository it is a steering record at steering/<kind folder>/<lineage>.md on steering/<lineage>, or for a memory steering/memory/workspace/general/<lineage>.md on memory/<lineage>. A revision is written where the record lives now. A repository-scoped proposal in a steering repository is refused repository_scope_needs_repo unless the record it revises lists its repos. On GitLab the PR is a merge request. Re-runs the checks when the PR is already open.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      proposalId: z.string().regex(/^prp_[0-9A-Za-z]+$/),
    })
    .strict(),
  output: contextPrSchema,
});

export type ContextPrOpenInput = z.output<typeof contextPrOpen.input>;
export type ContextPrOpenOutput = z.output<typeof contextPrOpen.output>;
