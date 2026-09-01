import { z } from "zod";
import { registerCapability } from "../registry";
import { environmentSummarySchema } from "./environment.create";

export const environmentList = registerCapability({
  name: "list_environments",
  domain: "environment",
  description: "List the environments configured in the active workspace.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "introspection" },
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({}),
  output: z.object({ environments: z.array(environmentSummarySchema) }),
});

export type EnvironmentListOutput = z.output<typeof environmentList.output>;
