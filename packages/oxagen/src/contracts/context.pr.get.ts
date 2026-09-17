// get_context_pr — one proposal's Context PR: the state machine, its checks,
// what merge will do and, once merged, the promotion event (ADR-061; MC spec
// §10.3). The read the Context PR panel polls while checks run.
import { z } from "zod";
import { registerCapability } from "../registry";
import { contextPrSchema } from "./context.pr.open";

export const contextPrGet = registerCapability({
  name: "get_context_pr",
  domain: "context",
  description:
    "Get a proposal's Context PR: state, branch, checks with their outcomes, what merge will do, and the promotion event once merged",
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
      proposalId: z.string().regex(/^prp_[0-9A-Za-z]+$/),
    })
    .strict(),
  output: contextPrSchema,
});

export type ContextPrGetInput = z.output<typeof contextPrGet.input>;
export type ContextPrGetOutput = z.output<typeof contextPrGet.output>;
