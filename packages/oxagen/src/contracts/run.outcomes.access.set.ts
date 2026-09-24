import { z } from "zod";
import { registerCapability } from "../registry";
import { runOutcomesPolicySchema } from "../run-outcomes";

export const runOutcomesAccessSet = registerCapability({
  name: "set_run_outcomes_access",
  domain: "run",
  description:
    "Platform-operator only: suspend or restore an organization's run follow-through access with a recorded reason.",
  mode: "sync",
  surfaces: [],
  layers: ["schema", "unit", "docs"],
  scoped: false,
  platformOnly: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: {}, workspace: {} },
  input: z
    .object({
      orgId: z.string().uuid(),
      disabled: z.boolean(),
      reason: z.string().trim().min(1).max(500),
    })
    .strict(),
  output: runOutcomesPolicySchema,
});
