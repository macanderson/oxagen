/**
 * Context-quality eval harness (Axis B — does the engine pack the right context?).
 *
 * - {@link runEvalSuite} replays golden traces through a context compiler and scores
 *   `EvalMetrics` (contextPrecision / contextRecall / retrievalHitRate / …).
 * - {@link GOLDEN_TRACES} + {@link makeGoldenCompileFn} instantiate it with a real,
 *   dependency-free fixture; golden-suite.test.ts runs it as a CI regression gate.
 * - {@link writeRagDataset} exports the same fixture for the Python RAGAS/DeepEval
 *   cross-validation in `bench/rag-eval/`.
 */
export { runEvalSuite } from "./harness";
export type { EvalRunResult, EvalSuiteResult } from "./harness";
export { detectRegressions, DEFAULT_THRESHOLDS } from "./metrics";
export type { EvalMetrics, MetricThresholds, MetricRegression } from "./metrics";
export { validateTurn } from "./golden-traces";
export type { GoldenTrace, GoldenTurn, TurnValidation } from "./golden-traces";
export { generateTextReport, generateJsonReport } from "./report";
export {
  GOLDEN_CORPUS,
  GOLDEN_TRACES,
  GOLDEN_GROUND_TRUTH,
  hex64,
} from "./golden-fixtures";
export { makeGoldenCompileFn, rankCorpus } from "./golden-compile";
export type { CompiledRecord } from "./golden-compile";
export {
  runGoldenSuite,
  buildRagDataset,
  writeRagDataset,
} from "./run-golden";
export type { RagDatasetRecord } from "./run-golden";
