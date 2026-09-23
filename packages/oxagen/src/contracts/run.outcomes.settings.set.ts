import { z } from "zod";
import { registerCapability } from "../registry";
import { runOutcomesPolicySchema } from "../run-outcomes";

export const runOutcomesSettingsSet = registerCapability({
  name: "set_run_outcomes_settings",
  domain: "run",
  description:
    "Set explicit organization consent for metered run follow-through. Platform suspension remains independent.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "app", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ customerEnabled: z.boolean() }).strict(),
  output: runOutcomesPolicySchema,
});
