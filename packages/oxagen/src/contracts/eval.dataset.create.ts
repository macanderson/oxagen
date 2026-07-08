import { z } from "zod";
import { registerCapability } from "../registry";

export const evalDatasetCreate = registerCapability({
  name: "create_dataset",
  domain: "eval",
  description:
    "Create an eval dataset — a named, workspace-scoped collection of cases to score a target against. Items are added separately via eval.dataset.item.add or captured from metered traces via eval.dataset.from_traces.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Management op — creates a definition row, spends no AI tokens.
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "mutation" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    name: z.string().min(1),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase kebab-case")
      .optional(),
    description: z.string().optional(),
  }),
  output: z.object({
    datasetId: z.string(),
    publicId: z.string(),
    slug: z.string(),
  }),
});

export type EvalDatasetCreateInput = z.output<typeof evalDatasetCreate.input>;
export type EvalDatasetCreateOutput = z.output<typeof evalDatasetCreate.output>;
