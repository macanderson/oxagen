// list_proposals — the workspace's proposals with their support and, once a
// Context PR is open, its state (ADR-061; MC spec §9.2, App. E). The read
// behind the Proposals and Context PRs tabs and the Steering nav count.
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  proposalStatusSchema,
  proposalViewSchema,
} from "./context.steering.shared";

export const contextProposalList = registerCapability({
  name: "list_proposals",
  domain: "context",
  description:
    "List the workspace's record proposals with their support and Context PR state, newest first, optionally narrowed to one status or lineage",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      status: proposalStatusSchema.optional(),
      lineageId: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().nonnegative().default(0),
    })
    .strict(),
  output: z
    .object({
      proposals: z.array(proposalViewSchema),
      total: z.number().int().nonnegative(),
    })
    .strict(),
});

export type ContextProposalListInput = z.output<
  typeof contextProposalList.input
>;
export type ContextProposalListOutput = z.output<
  typeof contextProposalList.output
>;
