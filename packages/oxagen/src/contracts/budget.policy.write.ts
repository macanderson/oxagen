import { z } from "zod";
import { registerCapability } from "../registry";

// Mirrors TURN_BUDGET_MODES in @oxagen/billing (literal to keep the contract
// layer dependency-light). Ordered soft → gated → hard.
const budgetMode = z.enum(["grace", "prompt", "enforce"]);

export const budgetPolicyWrite = registerCapability({
  name: "update_user_budget",
  domain: "user",
  description:
    "Update the calling user's saved per-turn budget (partial update — only provided fields change). Turn the per-turn dollar ceiling on/off, set the limit in USD, choose the enforcement mode (grace = allow overage within a grace window, then stop; prompt = pause and ask to continue; enforce = hard stop the instant the limit is crossed), and set the grace-window cushion.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "user" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow", Viewer: "allow" },
    workspace: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Viewer: "allow",
    },
  },
  input: z.object({
    // Turn the per-turn budget on or off. omit = no change.
    enabled: z.boolean().optional(),
    // Per-turn ceiling in USD. omit = no change; null = clear the limit; number = set (> 0).
    limitUsd: z.number().positive().nullable().optional(),
    // Enforcement mode. omit = no change.
    mode: budgetMode.optional(),
    // grace cushion as a fraction ABOVE the limit (0.25 = allow 25% overage).
    // Capped at 10 (1000%) so a fat-fingered value can't disable the ceiling.
    graceOveragePct: z.number().min(0).max(10).optional(),
  }),
  output: z.object({
    enabled: z.boolean(),
    limitUsd: z.number().nullable(),
    mode: budgetMode,
    graceOveragePct: z.number(),
  }),
});

export type BudgetPolicyWriteInput = z.output<typeof budgetPolicyWrite.input>;
export type BudgetPolicyWriteOutput = z.output<typeof budgetPolicyWrite.output>;
