// refresh_context_pr — read one proposal's Context PR from the repository
// host now and move the proposal to what the host says (ADR-184 decision 5).
// The webhook and the five-minute sweep already do this for every open PR;
// this is the one-PR path for a person who wants the host's answer now, and
// for the Context PR page, which asks once when it opens so a missed delivery
// never leaves the page showing a state the host does not agree with.
//
// A PR the host closed without merging is closed here, with the sync's
// reason and no person as its closer. A PR whose head moved has its checks
// reset to pending. A PR the host merged is published by the repository
// sync, never inside this request (ADR-184 decision 5), so the call asks for
// a sync and answers `syncRequested`. A proposal a merge from Oxagen has
// claimed is left to that merge. The host's own state comes back either way,
// so a caller can say what the host shows while the sync catches up.
import { z } from "zod";
import { registerCapability } from "../registry";
import { proposalStatusSchema } from "./context.steering.shared";

export const contextPrRefresh = registerCapability({
  name: "refresh_context_pr",
  domain: "context",
  description:
    "Read a proposal's Context PR from GitHub or GitLab now and move the proposal to the host's state: a pull request closed on the host is closed, a moved head resets the checks to pending, and a merge on the host asks the repository sync to publish it. Answers the host's state and the proposal's status after the refresh.",
  mode: "sync",
  surfaces: ["api", "agent"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  // It writes only what the host already says, so it asks no one first.
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "governance",
  },
  sensitivity: "low",
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
      /** The proposal's status after the refresh. */
      status: proposalStatusSchema,
      /** What the host says about the pull request; null when no pull request was opened. */
      host: z
        .object({
          state: z.enum(["open", "merged", "closed"]),
          headSha: z.string().nullable(),
          baseRef: z.string(),
        })
        .strict()
        .nullable(),
      /** True when the refresh moved the proposal. */
      changed: z.boolean(),
      /** True when the host merged the pull request and the repository sync was asked to publish it. */
      syncRequested: z.boolean(),
    })
    .strict(),
});

export type ContextPrRefreshInput = z.output<typeof contextPrRefresh.input>;
export type ContextPrRefreshOutput = z.output<typeof contextPrRefresh.output>;
