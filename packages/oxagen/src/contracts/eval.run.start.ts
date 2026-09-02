import { z } from "zod";
import { registerCapability } from "../registry";
import { evalTargetSchema } from "./eval-schema";

export const evalRunStart = registerCapability({
  name: "start_eval_run",
  domain: "eval",
  description:
    "Start an eval run: enqueue a background job that runs every dataset item through the target (a model+prompt or an agent) and scores each output with an LLM judge. Target and judge calls flow through @oxagen/ai, so tokens, latency, and cost land in the metering pipe. Poll get_eval_status / get_eval_run for results.",
  // Async: returns a run handle immediately; the Inngest worker does the work.
  mode: "async",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  // Intentionally billing-gated: this consumes AI tokens (target + judge), so
  // an org with zero balance must be refused at admission. Do NOT set noBillingGate.
  agent: { requiresApproval: false, riskLevel: "medium", category: "mutation" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    datasetPublicId: z.string().min(1),
    target: evalTargetSchema,
    /** Gateway model slug for the judge; omitted → the precise tier. */
    judgeModel: z.string().min(1).optional(),
    name: z.string().optional(),
    /** Overall judge score at/above which an item passes. */
    passThreshold: z.number().min(0).max(1).default(0.7),
    /** Cap items evaluated this run (cost control); omitted → all items. */
    maxItems: z.number().int().min(1).max(500).optional(),
  }),
  output: z.object({
    runId: z.string(),
    status: z.literal("pending"),
    itemCount: z.number().int().nonnegative(),
  }),
});

export type EvalRunStartInput = z.output<typeof evalRunStart.input>;
export type EvalRunStartOutput = z.output<typeof evalRunStart.output>;
