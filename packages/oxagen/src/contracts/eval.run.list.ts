import { z } from "zod";
import { registerCapability } from "../registry";

export const evalRunList = registerCapability({
  name: "list_eval_runs",
  domain: "eval",
  description:
    "List eval runs for the workspace (optionally scoped to one dataset) with server-side date/status/model filtering, sorting, and pagination — the read that backs a sortable eval-runs table. Rolls up per-run cost and token totals from the ClickHouse metering pipe.",
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
    /** Restrict to one dataset (its public id); omit for all workspace runs. */
    datasetPublicId: z.string().min(1).optional(),
    /** ISO datetime — only runs created at/after this instant. */
    since: z.string().datetime().optional(),
    /** ISO datetime — only runs created at/before this instant. */
    until: z.string().datetime().optional(),
    /** Only runs in this lifecycle state. */
    status: z
      .enum([
        "pending",
        "queued",
        "running",
        "completed",
        "failed",
        "cancelled",
      ])
      .optional(),
    /** Only runs whose target model (target->>'model') matches exactly. */
    model: z.string().min(1).optional(),
    sortBy: z.enum(["score", "created", "model", "status"]).default("created"),
    sortDir: z.enum(["asc", "desc"]).default("desc"),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  }),
  output: z.object({
    runs: z.array(
      z.object({
        runId: z.string(),
        datasetId: z.string(),
        datasetName: z.string(),
        datasetSlug: z.string(),
        name: z.string().nullable(),
        target: z.object({
          kind: z.enum(["model", "agent"]),
          model: z.string().nullable(),
          agentSlug: z.string().nullable(),
        }),
        judgeModel: z.string(),
        status: z.string(),
        itemCount: z.number().int().nonnegative(),
        completedCount: z.number().int().nonnegative(),
        failedCount: z.number().int().nonnegative(),
        avgScore: z.number().nullable(),
        passThreshold: z.number(),
        costUsdMicros: z.number().nonnegative(),
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
        createdAt: z.string(),
        completedAt: z.string().nullable(),
      }),
    ),
    /** Total rows matching the filter set (ignores limit/offset). */
    total: z.number().int().nonnegative(),
    /** Total live runs in scope (ignores since/until/status/model). */
    allTimeTotal: z.number().int().nonnegative(),
  }),
});

export type EvalRunListInput = z.output<typeof evalRunList.input>;
export type EvalRunListOutput = z.output<typeof evalRunList.output>;
