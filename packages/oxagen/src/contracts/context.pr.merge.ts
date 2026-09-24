// merge_context_pr — merge is the publication (ADR-061; MC spec §10.3 steps
// 3-4). Refused until every check passed; the reviewer the governance mode
// names must be the caller (solo: any workspace member, the author included;
// team: an Owner or Admin other than the author; regulated: an org Owner or
// Admin other than the author, recorded as the accountable approver). On
// merge the handler publishes the record into the registry, appends the
// promotion event to the hash-chained ledger, and emits `steering.published`.
// The reviewer is a signed-in user; an API key carries no user, so the MCP
// surface (API-key auth) is not declared.
import { z } from "zod";
import { registerCapability } from "../registry";

export const contextPrMerge = registerCapability({
  name: "merge_context_pr",
  domain: "context",
  description:
    "Merge a proposal's Context PR (a GitHub pull request or a GitLab merge request) and publish its record: refused until every check passed and unless the caller is a reviewer the governance mode allows; writes the promotion event to the ledger, bumps the steering version and emits steering.published",
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
  output: z
    .object({
      proposalId: z.string(),
      status: z.literal("merged"),
      record: z
        .object({
          id: z.string(),
          lineageId: z.string(),
          version: z.number().int().positive(),
          path: z.string(),
        })
        .strict(),
      mergedCommit: z.string(),
      promotionEvent: z
        .object({
          id: z.string(),
          seq: z.number().int().positive(),
          chainDigest: z.string(),
        })
        .strict(),
      /** The workspace's steering version before and after: the ledger length. */
      bundleVersion: z
        .object({ before: z.number().int(), after: z.number().int() })
        .strict(),
    })
    .strict(),
});

export type ContextPrMergeInput = z.output<typeof contextPrMerge.input>;
export type ContextPrMergeOutput = z.output<typeof contextPrMerge.output>;
