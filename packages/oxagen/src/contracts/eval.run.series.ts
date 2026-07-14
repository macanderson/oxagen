import { z } from "zod";
import { registerCapability } from "../registry";

export const evalRunSeries = registerCapability({
  name: "get_eval_run_series",
  domain: "eval",
  description:
    "Bucketed score-over-time series for eval runs (optionally scoped to one dataset), plus a per-model breakdown (avg score, pass rate, and a time series) — the read that backs score-trend and model-comparison charts. Score only; no cost metric in v1.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  // No app surface yet: the score-trend / model-comparison charts this read is
  // meant to back are not wired in apps/app (no component invokes
  // get_eval_run_series). Drop "app" from layers until those charts ship —
  // re-add it with a binding + runtime proof in capability-ui-map.json then.
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
    /** Restrict to one dataset (its public id); omit for all workspace runs. */
    datasetPublicId: z.string().min(1).optional(),
    /** ISO datetime — only runs created at/after this instant. */
    since: z.string().datetime().optional(),
    /** ISO datetime — only runs created at/before this instant. */
    until: z.string().datetime().optional(),
    /** Time-bucket granularity for the series. */
    bucket: z.enum(["day", "week"]).default("day"),
  }),
  output: z.object({
    overall: z.array(
      z.object({
        bucketStart: z.string(),
        avgScore: z.number().nullable(),
        runCount: z.number().int().nonnegative(),
      }),
    ),
    byModel: z.array(
      z.object({
        model: z.string(),
        vendor: z.string(),
        avgScore: z.number().nullable(),
        passRate: z.number(),
        runCount: z.number().int().nonnegative(),
        points: z.array(
          z.object({
            bucketStart: z.string(),
            avgScore: z.number().nullable(),
          }),
        ),
      }),
    ),
  }),
});

export type EvalRunSeriesInput = z.output<typeof evalRunSeries.input>;
export type EvalRunSeriesOutput = z.output<typeof evalRunSeries.output>;
