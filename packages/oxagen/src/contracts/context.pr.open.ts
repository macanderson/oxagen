// open_context_pr — the pull request that publishes a proposal (ADR-061; MC
// spec §10.3 step 1-2): a branch `context/<lineage>` from the production
// branch of the workspace's repository, the single record file under
// `.oxagen/rules/`, the PR with its body, then the six §10.3 checks one at a
// time, each mirrored as a GitHub check run or a GitLab commit status. On a
// GitLab main project the PR is a merge request (#3762). Calling it again on a proposal
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
        /** The workspace's steering version: the promotions ledger length. */
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
        promotionEventId: z.string(),
        recordId: z.string(),
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
    "Open the Context PR for a proposal: branch context/<lineage> from the production branch, the single record file under .oxagen/rules/, the PR body with rationale, supporting records and evidence, then the six checks one at a time as GitHub check runs or GitLab commit statuses. On GitLab the PR is a merge request. Re-runs the checks when the PR is already open.",
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
