import { z } from "zod";
import { registerCapability } from "../registry";

const budgetMode = z.enum(["grace", "prompt", "enforce"]);
const enforcementKind = z.enum(["default", "ceiling"]);

export const workspaceBudgetPolicyWrite = registerCapability({
  name: "update_budget_policy",
  domain: "workspace",
  description:
    "Set the workspace's governed per-turn dollar budget (partial update — only provided fields change). An org/workspace admin can dictate a budget for a workspace: turn it on/off, set the USD limit, choose the enforcement mode (grace = allow overage within a grace window then stop; prompt = ask to continue; enforce = hard stop), the grace cushion, and whether it is a soft `default` (seeds members who haven't set their own) or a hard `ceiling` (clamps members — they cannot exceed it and the mode can only get stricter). Owner/Admin only.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "workspace",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    // omit = no change.
    enabled: z.boolean().optional(),
    // omit = no change; null = clear the limit; number = set (> 0).
    limitUsd: z.number().positive().nullable().optional(),
    mode: budgetMode.optional(),
    graceOveragePct: z.number().min(0).max(10).optional(),
    // "ceiling" (hard cap) vs "default" (member-overridable seed).
    enforcement: enforcementKind.optional(),
  }),
  output: z.object({
    enabled: z.boolean(),
    limitUsd: z.number().nullable(),
    mode: budgetMode,
    graceOveragePct: z.number(),
    enforcement: enforcementKind,
  }),
});

export type WorkspaceBudgetPolicyWriteInput = z.output<
  typeof workspaceBudgetPolicyWrite.input
>;
export type WorkspaceBudgetPolicyWriteOutput = z.output<
  typeof workspaceBudgetPolicyWrite.output
>;
