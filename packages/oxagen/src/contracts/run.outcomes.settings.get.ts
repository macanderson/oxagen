import { z } from "zod";
import { registerCapability } from "../registry";
import { runOutcomesPolicySchema } from "../run-outcomes";

export const runOutcomesSettingsGet = registerCapability({
  name: "get_run_outcomes_settings",
  domain: "run",
  description:
    "Read organization consent and platform suspension for metered run follow-through.",
  mode: "sync",
  surfaces: ["api", "agent"],
  layers: ["schema", "api", "app", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
      Billing: "allow",
    },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  agent: { requiresApproval: false, riskLevel: "low", category: "run" },
  input: z.object({}).strict(),
  output: runOutcomesPolicySchema,
});
