import { createFunction } from "../create-function";
import { schema, withTenantDb } from "@oxagen/database";
import { and, asc, desc, eq } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  insertEvalItemResults,
  type EvalItemResultRow,
} from "@oxagen/telemetry";
import { providerCostUsdMicros } from "@oxagen/billing";
import {
  evalTargetSchema,
  type EvalTarget,
} from "@oxagen/oxagen/contracts/eval-schema";
import "@oxagen/oxagen";
import { logger } from "../logger";
import { runTarget } from "./eval/target";
import { scoreWithJudge } from "./eval/judge";

interface EvalRunStartEvent {
  orgId: string;
  workspaceId: string;
  runId: string;
  runPublicId: string;
  datasetId: string;
  maxItems: number | null;
}

/** Per-item outcome accumulated into the run summary. */
interface ItemOutcome {
  status: "completed" | "failed";
  score: number;
  correctness: number;
  faithfulness: number;
  passed: boolean;
}

const TELEMETRY_SURFACE = "runner" as const;

/**
 * Evals v1 run executor. Consumes `eval/run.start`, runs every dataset item
 * through the target (a model+prompt or an agent's instruction prompt) and
 * scores each output with the LLM judge. Target + judge calls flow through
 * @oxagen/ai, so tokens/cost land in the metering pipe; per-item detail is
 * written to ClickHouse eval_item_results and the summary is rolled up into
 * Postgres eval.eval_runs.
 *
 * retries: 0 — the run owns its own per-item error isolation (a failed item is
 * recorded, not retried), and a mid-run replay would double-charge tokens.
 */
export const [evalRunExecute] = createFunction(
  {
    id: "eval.run.execute",
    retries: 0,
    concurrency: { limit: 3, key: "event.data.orgId" },
  },
  { event: "eval/run.start" },
  async ({ event, step }) => {
    const { orgId, workspaceId, runId, runPublicId, datasetId, maxItems } =
      event.data as unknown as EvalRunStartEvent;

    const scope = { orgId, workspaceId };

    // Load the run header (target, judge model, threshold, effective count).
    const runRow = await step.run("load-run", () =>
      runInTenantScope(scope, () =>
        withTenantDb(async (tx) => {
          const [r] = await tx
            .select({
              target: schema.evalRuns.target,
              judgeModel: schema.evalRuns.judgeModel,
              passThreshold: schema.evalRuns.passThreshold,
              itemCount: schema.evalRuns.itemCount,
            })
            .from(schema.evalRuns)
            .where(eq(schema.evalRuns.id, runId))
            .limit(1);
          return r ?? null;
        }),
      ),
    );
    if (!runRow) {
      logger.error({ runId, orgId }, "eval.run.execute: run row not found");
      return { runId: runPublicId, status: "failed" as const };
    }

    const target: EvalTarget = evalTargetSchema.parse(runRow.target);
    const judgeModelId = runRow.judgeModel;
    const passThreshold = Number(runRow.passThreshold);
    const limit = runRow.itemCount;

    await step.run("mark-running", () =>
      runInTenantScope(scope, () =>
        withTenantDb((tx) =>
          tx
            .update(schema.evalRuns)
            .set({ status: "running", startedAt: new Date() })
            .where(eq(schema.evalRuns.id, runId)),
        ),
      ),
    );

    // Resolve the agent's instruction prompt once when the target is an agent.
    // v1 evaluates the agent's published instructions with the balanced tier —
    // it does not replay the agent's full tool loop (a deliberate v1 scope).
    let agentSystemPrompt: string | null = null;
    if (target.kind === "agent") {
      agentSystemPrompt = await step.run("resolve-agent", () =>
        runInTenantScope(scope, () =>
          withTenantDb(async (tx) => {
            const [row] = await tx
              .select({ config: schema.agentVersions.config })
              .from(schema.agents)
              .innerJoin(
                schema.agentVersions,
                eq(schema.agentVersions.agentId, schema.agents.id),
              )
              .where(
                and(
                  eq(schema.agents.slug, target.agentSlug),
                  eq(schema.agents.workspaceId, workspaceId),
                ),
              )
              .orderBy(desc(schema.agentVersions.version))
              .limit(1);
            const config = (row?.config ?? {}) as { instructions?: string };
            return config.instructions ?? null;
          }),
        ),
      );
    }

    // Load the items to evaluate (deterministic order, capped at the effective count).
    const items = await step.run("load-items", () =>
      runInTenantScope(scope, () =>
        withTenantDb((tx) =>
          tx
            .select({
              publicId: schema.evalDatasetItems.publicId,
              input: schema.evalDatasetItems.input,
              expectedOutput: schema.evalDatasetItems.expectedOutput,
            })
            .from(schema.evalDatasetItems)
            .where(eq(schema.evalDatasetItems.datasetId, datasetId))
            .orderBy(asc(schema.evalDatasetItems.id))
            .limit(maxItems ? Math.min(maxItems, limit) : limit),
        ),
      ),
    );

    const outcomes: ItemOutcome[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const outcome = await step.run(`item-${i}`, () =>
        runInTenantScope(scope, async (): Promise<ItemOutcome> => {
          const telemetry = {
            orgId,
            workspaceId,
            surface: TELEMETRY_SURFACE,
            messageId: null,
          };
          const startedAt = Date.now();
          try {
            const targetRes = await runTarget({
              input: item.input,
              systemPrompt:
                target.kind === "model"
                  ? (target.systemPrompt ?? null)
                  : agentSystemPrompt,
              modelId: target.kind === "model" ? (target.model ?? null) : null,
              telemetry,
            });
            const judgeRes = await scoreWithJudge({
              input: item.input,
              expectedOutput: item.expectedOutput,
              output: targetRes.output,
              judgeModelId,
              telemetry,
            });

            const inputTokens =
              targetRes.usage.promptTokens + judgeRes.usage.promptTokens;
            const outputTokens =
              targetRes.usage.completionTokens +
              judgeRes.usage.completionTokens;
            const costUsdMicros =
              providerCostUsdMicros({
                model: targetRes.modelId,
                inputTokens: targetRes.usage.promptTokens,
                outputTokens: targetRes.usage.completionTokens,
                cachedTokens: 0,
              }) +
              providerCostUsdMicros({
                model: judgeModelId,
                inputTokens: judgeRes.usage.promptTokens,
                outputTokens: judgeRes.usage.completionTokens,
                cachedTokens: 0,
              });

            const passed = judgeRes.score.score >= passThreshold ? 1 : 0;
            const row: EvalItemResultRow = {
              run_id: runPublicId,
              dataset_id: datasetId,
              item_id: item.publicId,
              target_kind: target.kind,
              model: targetRes.modelId,
              judge_model: judgeModelId,
              score: judgeRes.score.score,
              correctness: judgeRes.score.correctness,
              faithfulness: judgeRes.score.faithfulness,
              passed,
              latency_ms: Date.now() - startedAt,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cost_usd_micros: costUsdMicros,
              status: "completed",
              error_class: "",
              output: targetRes.output,
              rationale: judgeRes.score.rationale,
            };
            await insertEvalItemResults([row]);
            return {
              status: "completed",
              score: judgeRes.score.score,
              correctness: judgeRes.score.correctness,
              faithfulness: judgeRes.score.faithfulness,
              passed: passed === 1,
            };
          } catch (err) {
            // Per-item isolation: record the failure and keep the run going.
            const errorClass = err instanceof Error ? err.name : "UnknownError";
            const failedRow: EvalItemResultRow = {
              run_id: runPublicId,
              dataset_id: datasetId,
              item_id: item.publicId,
              target_kind: target.kind,
              model: target.kind === "model" ? (target.model ?? "") : "",
              judge_model: judgeModelId,
              score: 0,
              correctness: 0,
              faithfulness: 0,
              passed: 0,
              latency_ms: Date.now() - startedAt,
              input_tokens: 0,
              output_tokens: 0,
              cost_usd_micros: 0,
              status: "failed",
              error_class: errorClass,
              output: "",
              rationale: err instanceof Error ? err.message : String(err),
            };
            await insertEvalItemResults([failedRow]);
            logger.warn(
              { runId: runPublicId, itemId: item.publicId, err },
              "eval item failed",
            );
            return {
              status: "failed",
              score: 0,
              correctness: 0,
              faithfulness: 0,
              passed: false,
            };
          }
        }),
      );
      outcomes.push(outcome);
    }

    // Roll the per-item outcomes up into the Postgres run summary.
    const completed = outcomes.filter((o) => o.status === "completed");
    const failedCount = outcomes.length - completed.length;
    const mean = (nums: number[]) =>
      nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
    const avgScore =
      completed.length > 0 ? mean(completed.map((o) => o.score)) : null;
    const scoreBreakdown = {
      correctness: mean(completed.map((o) => o.correctness)),
      faithfulness: mean(completed.map((o) => o.faithfulness)),
      passRate:
        completed.length > 0
          ? completed.filter((o) => o.passed).length / completed.length
          : 0,
    };

    await step.run("mark-completed", () =>
      runInTenantScope(scope, () =>
        withTenantDb((tx) =>
          tx
            .update(schema.evalRuns)
            .set({
              status: "completed",
              completedCount: completed.length,
              failedCount,
              avgScore: avgScore != null ? String(avgScore) : null,
              scoreBreakdown,
              completedAt: new Date(),
            })
            .where(eq(schema.evalRuns.id, runId)),
        ),
      ),
    );

    logger.info(
      {
        runId: runPublicId,
        completed: completed.length,
        failed: failedCount,
        avgScore,
      },
      "eval.run.execute completed",
    );
    return { runId: runPublicId, status: "completed" as const };
  },
);
