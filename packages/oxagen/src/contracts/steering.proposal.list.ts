// list_proposals — the workspace's proposals with their support and, once a
// steering PR is open, its state (ADR-061; MC spec §9.2, App. E). The read
// behind the Proposals and steering PRs tabs and the Steering nav count.
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  proposalStateSchema,
  proposalStatusSchema,
  proposalViewSchema,
} from "./context.steering.shared";

export const steeringProposalList = registerCapability({
  name: "list_proposals",
  domain: "context",
  description:
    "List the workspace's record proposals with their support and steering PR state, newest first, optionally narrowed to one status, one state (open, merged or closed) or one lineage",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
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
      /**
       * open, merged or closed, as a pull request list filters. Narrows with
       * `status` when both are given, so a status outside the state lists
       * nothing.
       */
      state: proposalStateSchema.optional(),
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

export type SteeringProposalListInput = z.output<
  typeof steeringProposalList.input
>;
export type SteeringProposalListOutput = z.output<
  typeof steeringProposalList.output
>;
