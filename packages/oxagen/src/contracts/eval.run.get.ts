import { z } from "zod";
import { registerCapability } from "../registry";
import { evalRunStatusSchema, evalTargetSchema } from "./eval-schema";

export const evalRunGet = registerCapability({
  name: "get_eval_run",
  aliases: ["eval.run.get"],
  domain: "eval",
  description:
    "Fetch an eval run's summary (from Postgres) together with its per-item results (from the ClickHouse metering pipe): each item's output, judge scores, pass/fail, tokens, latency, and cost.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
    run: z.object({
      runId: z.string(),
      datasetId: z.string(),
      name: z.string().nullable(),
      target: evalTargetSchema,
      judgeModel: z.string(),
      passThreshold: z.number(),
      status: evalRunStatusSchema,
      itemCount: z.number().int().nonnegative(),
      completedCount: z.number().int().nonnegative(),
      failedCount: z.number().int().nonnegative(),
      avgScore: z.number().nullable(),
      scoreBreakdown: z.record(z.string(), z.number()),
      createdAt: z.string(),
    }),
    results: z.array(
      z.object({
        itemId: z.string(),
        targetKind: z.string(),
        model: z.string(),
        judgeModel: z.string(),
        score: z.number(),
        correctness: z.number(),
        faithfulness: z.number(),
        passed: z.boolean(),
        latencyMs: z.number().int().nonnegative(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        costUsdMicros: z.number().int().nonnegative(),
        status: z.enum(["completed", "failed"]),
        errorClass: z.string(),
        output: z.string(),
        rationale: z.string(),
      }),
    ),
  }),
});

export type EvalRunGetInput = z.output<typeof evalRunGet.input>;
export type EvalRunGetOutput = z.output<typeof evalRunGet.output>;
