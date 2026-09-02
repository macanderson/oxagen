import { z } from "zod";
import { registerCapability } from "../registry";
import { evalRunStatusSchema } from "./eval-schema";

export const evalRunStatus = registerCapability({
  name: "get_eval_status",
  domain: "eval",
  description:
    "Poll an eval run's lifecycle: status, progress counts, and mean score once available. Cheap header read — use get_eval_run for per-item detail.",
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
  input: z.object({
    runPublicId: z.string().min(1),
  }),
  output: z.object({
    runId: z.string(),
    status: evalRunStatusSchema,
    itemCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    avgScore: z.number().nullable(),
    failureReason: z.string().nullable(),
  }),
});

export type EvalRunStatusInput = z.output<typeof evalRunStatus.input>;
export type EvalRunStatusOutput = z.output<typeof evalRunStatus.output>;
