import { z } from "zod";
import { registerCapability } from "../registry";
import { routingModeSchema, routingPolicyScopeSchema } from "./router-schema";

// `set_routing_policy` updates the Verified-Outcome Market Router policy at the
// org OR workspace scope (partial update — only provided fields change). This
// changes how the platform spends on models, so it is HIGH sensitivity and
// gated to org Owner/Admin (and workspace Owner/Admin for the workspace scope).
// Turning the market on can raise or lower spend, hence riskLevel "high".
export const routerPolicySet = registerCapability({
  name: "set_routing_policy",
  domain: "router",
  description:
    "Set the market-router policy for this org or workspace (partial update). Choose the mode (off = deterministic routing; shadow = compute + record the market decision but keep today's routing; enforce = route to the cheapest model clearing the verified-success bar and escalate tiers on judge rejection), the verified-success threshold, min samples, window days, and tier-escalation. Changes model spend behavior — Owner/Admin only.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "settings" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    // Which scope to write. Omit ⇒ "workspace". "org" sets the org-level default
    // (applies to every workspace that has no policy of its own).
    scope: routingPolicyScopeSchema.optional(),
    // Each field omitted ⇒ no change (merged with the existing row / defaults).
    mode: routingModeSchema.optional(),
    successThreshold: z.number().min(0).max(1).optional(),
    minSamples: z.number().int().nonnegative().optional(),
    windowDays: z.number().int().positive().optional(),
    escalateOnRejection: z.boolean().optional(),
  }),
  output: z.object({
    scope: routingPolicyScopeSchema,
    mode: routingModeSchema,
    successThreshold: z.number(),
    minSamples: z.number().int().nonnegative(),
    windowDays: z.number().int().positive(),
    escalateOnRejection: z.boolean(),
  }),
});

export type RouterPolicySetInput = z.output<typeof routerPolicySet.input>;
export type RouterPolicySetOutput = z.output<typeof routerPolicySet.output>;
