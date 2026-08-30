import { z } from "zod";
import { registerCapability } from "../registry";

const budgetMode = z.enum(["grace", "prompt", "enforce"]);
const enforcementKind = z.enum(["default", "ceiling"]);

export const workspaceBudgetPolicyRead = registerCapability({
  name: "get_budget_policy",
  domain: "workspace",
  description:
    "Read the workspace's governed per-turn dollar budget: whether the org/workspace enforces a budget on each agent turn in this workspace, the limit in USD, the enforcement mode (grace/prompt/enforce), the grace cushion, and whether it is a soft default (seeds members) or a hard ceiling (members cannot exceed it). Readable by all members so the composer can show an enforced ceiling.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
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
  input: z.object({}),
  output: z.object({
    /** Whether a governed budget is active for this workspace (false ⇒ no governance). */
    enabled: z.boolean(),
    /** Governed ceiling/default in USD; null when no amount is set. */
    limitUsd: z.number().nullable(),
    mode: budgetMode,
    graceOveragePct: z.number(),
    /** "ceiling" = hard cap members cannot exceed; "default" = seed members can override. */
    enforcement: enforcementKind,
  }),
});

export type WorkspaceBudgetPolicyReadOutput = z.output<
  typeof workspaceBudgetPolicyRead.output
>;
