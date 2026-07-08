import { z } from "zod";
import { registerCapability } from "../registry";

export const evalDatasetList = registerCapability({
  name: "list_datasets",
  aliases: ["eval.dataset.list"],
  domain: "eval",
  description:
    "List the workspace's eval datasets with their item counts, source (manual or traces), and timestamps.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({}),
  output: z.object({
    datasets: z.array(
      z.object({
        datasetId: z.string(),
        name: z.string(),
        slug: z.string(),
        description: z.string().nullable(),
        source: z.enum(["manual", "traces"]),
        itemCount: z.number().int().nonnegative(),
        createdAt: z.string(),
      }),
    ),
  }),
});

export type EvalDatasetListInput = z.output<typeof evalDatasetList.input>;
export type EvalDatasetListOutput = z.output<typeof evalDatasetList.output>;
