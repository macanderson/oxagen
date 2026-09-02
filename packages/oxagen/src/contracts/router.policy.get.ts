import { z } from "zod";
import { registerCapability } from "../registry";
import { routingModeSchema, routingPolicySourceSchema } from "./router-schema";

// `get_routing_policy` reads the EFFECTIVE Verified-Outcome Market Router policy
// for the current org/workspace scope, together with its provenance (which scope
// supplied it: the workspace's own row, the org-level default, or the built-in
// OFF default). Read-only; any org member may read it.
export const routerPolicyGet = registerCapability({
  name: "get_routing_policy",
  domain: "router",
  description:
    "Read the effective market-router policy for the current scope (mode, verified-success threshold, min samples, window, tier-escalation) plus its provenance (workspace / org / default).",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Viewer: "allow",
    },
  },
  input: z.object({}),
  output: z.object({
    mode: routingModeSchema,
    successThreshold: z.number(),
    minSamples: z.number().int().nonnegative(),
    windowDays: z.number().int().positive(),
    escalateOnRejection: z.boolean(),
    /** Which scope the effective policy came from. */
    source: routingPolicySourceSchema,
  }),
});

export type RouterPolicyGetInput = z.output<typeof routerPolicyGet.input>;
export type RouterPolicyGetOutput = z.output<typeof routerPolicyGet.output>;
