import { z } from "zod";
import { registerCapability } from "../registry";
import { environmentSummarySchema } from "./environment.create";

export const environmentGet = registerCapability({
  name: "get_environment",
  domain: "environment",
  description: "Fetch a single workspace environment by its public id.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "introspection" },
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ environmentId: z.string().min(1) }),
  output: z.object({ environment: environmentSummarySchema }),
});

export type EnvironmentGetOutput = z.output<typeof environmentGet.output>;
