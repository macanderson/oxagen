// get_steering_pr — one proposal's steering PR: the state machine, its checks,
// what merge will do and, once merged, the promotion event (ADR-061; MC spec
// §10.3). The read the steering PR panel polls while checks run.
import { z } from "zod";
import { registerCapability } from "../registry";
import { steeringPrSchema } from "./steering.pr.open";

export const steeringPrGet = registerCapability({
  name: "get_steering_pr",
  domain: "context",
  description:
    "Get a proposal's steering PR: state, branch, checks with their outcomes, what merge will do, and the promotion event once merged",
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
      proposalId: z.string().regex(/^prp_[0-9A-Za-z]+$/),
    })
    .strict(),
  output: steeringPrSchema,
});

export type SteeringPrGetInput = z.output<typeof steeringPrGet.input>;
export type SteeringPrGetOutput = z.output<typeof steeringPrGet.output>;
