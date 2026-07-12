import { z } from "zod";
import { registerCapability } from "../registry";
import { evalDatasetItemSchema } from "./eval-schema";

export const evalDatasetItemAdd = registerCapability({
  name: "add_dataset_item",
  domain: "eval",
  description:
    "Bulk-add cases to an eval dataset. Batch by design — one call inserts many items as a set and bumps the dataset's item count.",
  mode: "batch",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "mutation" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    datasetPublicId: z.string().min(1),
    items: z.array(evalDatasetItemSchema).min(1).max(1000),
  }),
  output: z.object({
    datasetId: z.string(),
    added: z.number().int().nonnegative(),
    itemCount: z.number().int().nonnegative(),
  }),
});

export type EvalDatasetItemAddInput = z.output<typeof evalDatasetItemAdd.input>;
export type EvalDatasetItemAddOutput = z.output<
  typeof evalDatasetItemAdd.output
>;
