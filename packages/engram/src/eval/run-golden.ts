/**
 * Runnable golden suite — wires the instantiated fixtures + deterministic compiler
 * into `runEvalSuite`, prints a report, and exports the RAGAS/DeepEval dataset.
 *
 *   pnpm --filter @oxagen/engram eval:golden        # run the gate + print report
 *   pnpm --filter @oxagen/engram eval:export        # also write bench/rag-eval/dataset.engram.jsonl
 *
 * The exported dataset uses the exact schema the Python RAGAS/DeepEval suite reads
 * (`bench/rag-eval/run_rag_eval.py --dataset ...`): one JSON object per line,
 * `{ id, question, contexts[], answer, ground_truth }`. This closes the round trip —
 * engram compiles the context (TS), RAGAS/DeepEval score it (Python) — so the
 * homegrown `contextPrecision`/`contextRecall` are cross-validated against the
 * industry-standard `context_precision`/`context_recall`.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { runEvalSuite, type EvalSuiteResult } from "./harness";
import { generateTextReport } from "./report";
import {
  GOLDEN_CORPUS,
  GOLDEN_TRACES,
  GOLDEN_GROUND_TRUTH,
} from "./golden-fixtures";
import { makeGoldenCompileFn } from "./golden-compile";

/** Run the golden suite through the harness. */
export function runGoldenSuite(): Promise<EvalSuiteResult> {
  return runEvalSuite(GOLDEN_TRACES, makeGoldenCompileFn(GOLDEN_CORPUS));
}

export interface RagDatasetRecord {
  id: string;
  question: string;
  contexts: string[];
  answer: string;
  ground_truth: string;
}

/**
 * Build the RAGAS/DeepEval dataset from the golden trace: for each turn, the
 * `contexts` are the fact texts the golden compiler actually packed, the
 * `ground_truth` is the canonical short answer, and `answer` echoes it (a faithful
 * agent) so faithfulness/answer-relevancy score high while a missing context still
 * drives `context_recall` < 1.
 */
export async function buildRagDataset(): Promise<RagDatasetRecord[]> {
  const compile = makeGoldenCompileFn(GOLDEN_CORPUS);
  const byId = new Map(GOLDEN_CORPUS.map((r) => [r.id, r]));
  const records: RagDatasetRecord[] = [];
  for (const trace of GOLDEN_TRACES) {
    for (const [i, turn] of trace.turns.entries()) {
      const packedIds = await compile(turn.taskFrame, turn.budget);
      const contexts = packedIds.map((id) => {
        const body = byId.get(id)?.body as { fact?: string } | undefined;
        return body?.fact ?? "";
      });
      const requiredId = turn.requiredInContext[0] ?? `${trace.id}-${i}`;
      const groundTruth = GOLDEN_GROUND_TRUTH[requiredId] ?? "";
      records.push({
        id: `${trace.id}-${i}`,
        question: turn.taskFrame.taskDescription,
        contexts,
        answer: groundTruth,
        ground_truth: groundTruth,
      });
    }
  }
  return records;
}

/** Repo root resolved from this file's location: packages/engram/src/eval → ../../../.. */
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

export async function writeRagDataset(outPath?: string): Promise<string> {
  const dest =
    outPath ?? resolve(repoRoot(), "bench/rag-eval/dataset.engram.jsonl");
  mkdirSync(dirname(dest), { recursive: true });
  const rows = await buildRagDataset();
  writeFileSync(
    dest,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  return dest;
}

async function main(): Promise<void> {
  const result = await runGoldenSuite();
  process.stdout.write(generateTextReport(result) + "\n");
  if (process.argv.includes("--export")) {
    const dest = await writeRagDataset();
    process.stdout.write(`\nExported RAGAS/DeepEval dataset → ${dest}\n`);
  }
  if (!result.overallPassed) process.exitCode = 1;
}

// Run only when invoked directly (tsx src/eval/run-golden.ts), not on import.
//
// This module is re-exported from the `@oxagen/engram` barrel, so it also
// loads inside the CJS API bundle, where `import.meta.url` is undefined and
// `fileURLToPath` throws at module load. Catch that and treat it as "not
// main" — a CJS bundle can never be a direct CLI entry.
//
// In a single-file ESM bundle (the CLI's standalone build), every module
// shares the bundle's own `import.meta.url`, so plain path equality would
// match any bundle entry point, not just this file. Requiring the resolved
// path to also end in `run-golden.(ts|js|mjs|cjs)` rules that out.
export function isDirectCliEntry(
  argv1: string | undefined = process.argv[1],
): boolean {
  try {
    if (argv1 === undefined) return false;
    const self = fileURLToPath(import.meta.url);
    return self === resolve(argv1) && /run-golden\.(ts|js|mjs|cjs)$/.test(self);
  } catch {
    return false;
  }
}

/* v8 ignore next 3 — module-load side effect, exercised via the CLI scripts */
if (isDirectCliEntry()) {
  void main();
}
