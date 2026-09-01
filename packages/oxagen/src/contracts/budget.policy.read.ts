import { z } from "zod";
import { registerCapability } from "../registry";

// The three enforcement modes, ordered soft → gated → hard. Canonical values
// mirror TURN_BUDGET_MODES in @oxagen/billing (kept as a literal here to keep
// the contract layer dependency-light — the values are a locked API surface).
const budgetMode = z.enum(["grace", "prompt", "enforce"]);

export const budgetPolicyRead = registerCapability({
  name: "get_user_budget",
  domain: "user",
  description:
    "Read the calling user's saved per-turn budget: whether a dollar ceiling is enforced on each agent turn, the limit in USD, the enforcement mode (grace = allow overage within a grace window; prompt = ask to continue; enforce = hard stop), and the grace-window cushion.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit"],
  scoped: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "user" },
  sensitivity: "low",
  mutates: false,
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
  input: z.object({}),
  output: z.object({
    /** When false, turns run with no dollar ceiling (the default). */
    enabled: z.boolean(),
    /** Per-turn ceiling in USD; null when no limit is set. */
    limitUsd: z.number().nullable(),
    /** What happens at the ceiling. */
    mode: budgetMode,
    /** grace mode: fraction ABOVE the limit allowed before a hard stop (0.25 = 25%). */
    graceOveragePct: z.number(),
  }),
});

export type BudgetPolicyReadOutput = z.output<typeof budgetPolicyRead.output>;
