/**
 * run-evals — the one command to run evals and land them in ClickHouse.
 *
 *   pnpm eval                                  # run the engram context-quality suite + ingest
 *   pnpm eval path/to/results.eval.json           # also ingest already-produced eval results
 *
 * The engram golden suite is the cheap, deterministic, no-external-deps everyday
 * eval (no LLM, no Docker), so it runs in-process here. Heavier external eval
 * harnesses emit a `.eval.json`; pass the file(s) to this command, or to
 * `pnpm eval:ingest`, to land them in ClickHouse.
 *
 * If CLICKHOUSE_* env is absent, results are still computed and written to
 * tools/eval-out/, and ingest is skipped with a notice (so offline runs work).
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runGoldenSuite, type EvalSuiteResult } from "@oxagen/engram";
import { closeClickhouse } from "@oxagen/telemetry";
import {
  ingestRun,
  loadEvalFile,
  clickhouseConfigured,
  type EvalRunFile,
  type NormalizedResult,
} from "./lib/eval-protocol";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = resolve(REPO_ROOT, "tools/eval-out");

/** The platform version stamped on a run — the thing being measured over time. */
function platformVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
    ) as {
      version?: string;
    };
    return pkg.version ?? "";
  } catch {
    return "";
  }
}

/** Map the engram suite result into the normalized `oxagen.eval.v1` run shape. */
function buildEngramRunFile(
  result: EvalSuiteResult,
  runId: string,
): EvalRunFile {
  const results: NormalizedResult[] = [];
  let nTasks = 0;
  let nPassed = 0;
  let sumPrecision = 0;
  let sumRecall = 0;
  let sumHitRate = 0;
  for (const trace of result.results) {
    sumPrecision += trace.metrics.contextPrecision;
    sumRecall += trace.metrics.contextRecall;
    sumHitRate += trace.metrics.retrievalHitRate;
    trace.turnResults.forEach((turn, i) => {
      nTasks++;
      if (turn.pass) nPassed++;
      results.push({
        task_id: `${trace.traceId}#${i}`,
        passed: turn.pass ? 1 : 0,
        reward: turn.precision,
        metrics: { precision: turn.precision },
        labels: {
          missing: String(turn.missingRequired.length),
          forbidden: String(turn.includedForbidden.length),
        },
      });
    });
  }
  const nTraces = Math.max(1, result.results.length);
  return {
    schema: "oxagen.eval.v1",
    run: {
      run_id: runId,
      run_group: process.env.OXAGEN_EVAL_GROUP ?? "",
      agent_name: "oxagen",
      agent_version: platformVersion(),
      model: "deterministic-lexical",
      harness: "engram-golden",
      suite: result.results[0]?.traceId ?? "engram-golden",
      // The engram golden suite measures the context/memory-graph retrieval quality.
      graph_code: 0,
      graph_exec: 0,
      graph_mem: 1,
      warm: 0,
      history_depth: 0,
      n_tasks: nTasks,
      n_passed: nPassed,
      resolved_rate: nTasks ? nPassed / nTasks : 0,
      metrics: {
        context_precision: sumPrecision / nTraces,
        context_recall: sumRecall / nTraces,
        retrieval_hit_rate: sumHitRate / nTraces,
      },
      labels: { overall_passed: String(result.overallPassed) },
    },
    results,
  };
}

async function main(): Promise<void> {
  const extraFiles = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const force = process.argv.includes("--force");

  // 1. Run the engram context-quality suite (deterministic, in-process).
  process.stdout.write("▶ engram-golden (context-quality suite)…\n");
  const result = await runGoldenSuite();
  const runFile = buildEngramRunFile(result, randomUUID());
  const run = runFile.run;
  const nTraces = Math.max(1, result.results.length);
  const precision =
    result.results.reduce((s, t) => s + t.metrics.contextPrecision, 0) /
    nTraces;
  const recall =
    result.results.reduce((s, t) => s + t.metrics.contextRecall, 0) / nTraces;
  process.stdout.write(
    `  ${run.n_passed}/${run.n_tasks} turns · precision ${(precision * 100).toFixed(1)}%` +
      ` · recall ${(recall * 100).toFixed(1)}% · ${result.overallPassed ? "PASS" : "FAIL"}\n`,
  );

  // 2. Persist the normalized result (record + re-ingestable artifact).
  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, "engram-golden.eval.json");
  writeFileSync(outPath, JSON.stringify(runFile, null, 2) + "\n", "utf8");
  process.stdout.write(`  wrote ${outPath}\n`);

  // 3. Collect any extra harness files passed on the command line.
  const allFiles: EvalRunFile[] = [runFile];
  for (const p of extraFiles) {
    try {
      allFiles.push(...loadEvalFile(p));
    } catch (err) {
      process.stderr.write(
        `  skipped ${p}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // 4. Ingest into ClickHouse (or skip cleanly when unconfigured).
  if (!clickhouseConfigured()) {
    process.stdout.write(
      "\nClickHouse not configured — results written to disk but not ingested.\n" +
        "Sync .env.local (pnpm env:pull) and run `pnpm eval:ingest tools/eval-out/*.eval.json`.\n",
    );
    return;
  }
  process.stdout.write("\n▶ ingesting into ClickHouse…\n");
  for (const file of allFiles) {
    const r = await ingestRun(file, { force });
    process.stdout.write(
      `  ${r.status.padEnd(22)} ${file.run.harness}/${file.run.suite} (${r.results} results)\n`,
    );
  }
}

main()
  .then(() => closeClickhouse())
  .catch(async (err: unknown) => {
    process.stderr.write(
      `run-evals failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await closeClickhouse();
    process.exitCode = 1;
  });
