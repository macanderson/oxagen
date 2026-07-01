/**
 * The unified pipeline config (Group 6, deliverable 3).
 *
 * This is the single source of truth the {@link import("./state-machine.js").Pipeline}
 * reads. It merges the config slices Groups 1-5 each own, read live from their
 * owning modules so there is exactly one place each value is defined:
 *   - runtime (Group 1): `runtime/config.ts` — the coordinator model.
 *   - routing (Group 2): `orchestrator/config.ts` — trivial threshold, switch budget, workers.
 *   - assist  (Group 4): `pipeline/config.ts` — enhancer / judge / survey + master `enabled`.
 *   - monitors (Group 5): `monitors/config.ts` — ask-first + dispatch triggers + poll cadence.
 *
 * Group 6 itself owns the pieces no earlier group defined — the graph slice,
 * `pipeline.verifyWork`, `pipeline.plan`, `pipeline.screenshots`, and the judge
 * retry loop — whose defaults live in `pipeline-config.json` next to this file.
 * Every value is validated on load; an out-of-range value throws rather than
 * silently degrading the gate.
 */
import { getCoordinator } from "../runtime/config.js";
import {
  getCheapBasicWorker,
  getDefaultCodeWorker,
  getSwitchCostTokenBudget,
  getTrivialMaxComplexity,
} from "../orchestrator/config.js";
import type { Complexity } from "../orchestrator/index.js";
import {
  getAskBeforeMonitoring,
  getDispatchOnPullRequest,
  getDispatchOnCiFix,
  getPollIntervalSeconds,
} from "../monitors/config.js";
import { readAssistConfig } from "./config.js";
import defaults from "./pipeline-config.json" with { type: "json" };

interface PipelineConfigFile {
  config: {
    pipeline: {
      enabled: boolean;
      verifyWork: boolean;
      plan: { minComplexity: Complexity };
      screenshots: { requireWhenScreenImpacted: boolean };
    };
    graph: { enabled: boolean; endpoint: string; maxNodes: number; fallbackToGrep: boolean };
  };
  loop: { maxJudgeRetries: number };
}

const FILE = defaults as unknown as PipelineConfigFile;

/** The graph slice (Group 3's config; defaulted here until Group 3 lands). */
export interface GraphConfig {
  enabled: boolean;
  endpoint: string;
  maxNodes: number;
  fallbackToGrep: boolean;
}

/** The fully-merged config the pipeline reads. */
export interface UnifiedConfig {
  pipeline: {
    enabled: boolean;
    verifyWork: boolean;
    promptEnhancement: { enabled: boolean; minAcceptableScore: number };
    survey: {
      enabled: boolean;
      maxQuestions: number;
      alwaysAllowFreeText: boolean;
      preferBestPracticeOverAsking: boolean;
    };
    judge: { enabled: boolean; defaultModel: string; mustDifferFromWorker: boolean };
    plan: { minComplexity: Complexity };
    screenshots: { requireWhenScreenImpacted: boolean };
  };
  runtime: { coordinator: string };
  routing: {
    trivialMaxComplexity: Complexity;
    switchCostTokenBudget: number;
    defaultCodeWorker: string;
    cheapBasicWorker: string;
  };
  graph: GraphConfig;
  monitors: {
    askBeforeMonitoring: boolean;
    dispatchOnPullRequest: boolean;
    dispatchOnCiFix: boolean;
    pollIntervalSeconds: number;
  };
  loop: { maxJudgeRetries: number };
}

/** Thrown when a merged config value is out of its valid range. */
export class InvalidPipelineConfigError extends Error {
  constructor(message: string) {
    super(`Invalid pipeline config: ${message}`);
    this.name = "InvalidPipelineConfigError";
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new InvalidPipelineConfigError(message);
}

/** Validate the merged config; throws {@link InvalidPipelineConfigError} on any bad value. */
export function validateUnifiedConfig(cfg: UnifiedConfig): void {
  const s = cfg.pipeline.promptEnhancement.minAcceptableScore;
  assert(s >= 0 && s <= 1, `promptEnhancement.minAcceptableScore must be 0..1 (got ${s})`);
  assert(cfg.pipeline.survey.maxQuestions >= 1, "survey.maxQuestions must be >= 1");
  assert(cfg.routing.switchCostTokenBudget >= 0, "routing.switchCostTokenBudget must be >= 0");
  assert(cfg.graph.maxNodes >= 1, "graph.maxNodes must be >= 1");
  assert(cfg.monitors.pollIntervalSeconds > 0, "monitors.pollIntervalSeconds must be > 0");
  assert(cfg.loop.maxJudgeRetries >= 0, "loop.maxJudgeRetries must be >= 0");
  assert(
    cfg.pipeline.judge.defaultModel.length > 0,
    "judge.defaultModel must be a non-empty model id",
  );
}

/**
 * Load and validate the unified config by merging every group's live slice with
 * this group's `pipeline-config.json` defaults. Throws on an invalid value.
 */
export function loadUnifiedConfig(): UnifiedConfig {
  const assist = readAssistConfig();
  const cfg: UnifiedConfig = {
    pipeline: {
      enabled: assist.enabled,
      verifyWork: FILE.config.pipeline.verifyWork,
      promptEnhancement: assist.promptEnhancement,
      survey: assist.survey,
      judge: assist.judge,
      plan: FILE.config.pipeline.plan,
      screenshots: FILE.config.pipeline.screenshots,
    },
    runtime: { coordinator: getCoordinator() },
    routing: {
      trivialMaxComplexity: getTrivialMaxComplexity(),
      switchCostTokenBudget: getSwitchCostTokenBudget(),
      defaultCodeWorker: getDefaultCodeWorker(),
      cheapBasicWorker: getCheapBasicWorker(),
    },
    graph: FILE.config.graph,
    monitors: {
      askBeforeMonitoring: getAskBeforeMonitoring(),
      dispatchOnPullRequest: getDispatchOnPullRequest(),
      dispatchOnCiFix: getDispatchOnCiFix(),
      pollIntervalSeconds: getPollIntervalSeconds(),
    },
    loop: { maxJudgeRetries: FILE.loop.maxJudgeRetries },
  };
  validateUnifiedConfig(cfg);
  return cfg;
}
