import { z } from "zod";
import { registerCapability } from "../registry";
import { environmentSummarySchema } from "./environment.create";

export const environmentSetDefault = registerCapability({
  name: "set_default_environment",
  domain: "environment",
  description:
    "Promote an environment to the workspace default. Atomically swaps the existing default; the promoted environment is reactivated.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "configuration",
  },
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ environmentId: z.string().min(1) }),
  output: z.object({ environment: environmentSummarySchema }),
});

export type EnvironmentSetDefaultInput = z.output<
  typeof environmentSetDefault.input
>;
export type EnvironmentSetDefaultOutput = z.output<
  typeof environmentSetDefault.output
>;
