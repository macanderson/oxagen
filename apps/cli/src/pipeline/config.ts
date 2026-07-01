/**
 * Pipeline config — the slice Group 4 owns (pipeline Group 4).
 *
 * The unified `pipeline-config.json` is Group 6's single source of truth; each
 * earlier group ships the slice of config it owns and Group 6 merges them. This
 * module owns the `pipeline.promptEnhancement`, `pipeline.judge`, and
 * `pipeline.survey` settings plus the master `pipeline.enabled` switch that turns
 * all three assist tools off at once.
 *
 * Values are read from `~/.config/oxagen/config.json` under a `pipeline` key and
 * layered over {@link DEFAULT_ASSIST_CONFIG}, so an unset field always falls back
 * to a sane default rather than `undefined`.
 */
import { readConfig } from "../lib/config.js";
import { LATEST_OPENAI_CODING } from "../agent/model-catalog.js";

export interface PromptEnhancementConfig {
  enabled: boolean;
  /** 0..1. Below this completeness the enhancer (or survey) fires. */
  minAcceptableScore: number;
}
export interface JudgeConfig {
  enabled: boolean;
  /** Gateway slug of the default judge — the most capable OpenAI coding model. */
  defaultModel: string;
  /** The judge must run on a model different from the worker. */
  mustDifferFromWorker: boolean;
}
export interface SurveyConfig {
  enabled: boolean;
  /** Hard cap on questions per survey — keep it short. */
  maxQuestions: number;
  /** Every question must offer a free-text answer. */
  alwaysAllowFreeText: boolean;
  /** Prefer a logged best-practice default over asking the developer. */
  preferBestPracticeOverAsking: boolean;
}

/**
 * Group 4's config slice. `enabled: false` turns off the judge, the prompt
 * enhancer, and the survey together — the agent then runs on best-practice
 * defaults with logged decisions.
 */
export interface AssistPipelineConfig {
  enabled: boolean;
  promptEnhancement: PromptEnhancementConfig;
  judge: JudgeConfig;
  survey: SurveyConfig;
}

/** A partial override written into `config.json` under `pipeline`. */
export type AssistPipelineConfigPatch = {
  enabled?: boolean;
  promptEnhancement?: Partial<PromptEnhancementConfig>;
  judge?: Partial<JudgeConfig>;
  survey?: Partial<SurveyConfig>;
};

/**
 * The default completeness threshold for prompt enhancement. Extracted so the
 * decision helper and the enhancer agree on one number.
 */
export const DEFAULT_MIN_ACCEPTABLE_SCORE = 0.7;

/**
 * The default judge: the most capable OpenAI coding model. A cross-vendor judge
 * shares none of a (typically Claude) worker's blind spots, which is the whole
 * point of the different-model rule. Kept in sync with the agent-engine advisor
 * default; override with `OXAGEN_LLM_JUDGE` to track gateway slug drift.
 */
export const DEFAULT_JUDGE_MODEL = LATEST_OPENAI_CODING;

/** Env var that overrides the judge model slug (gateway slugs drift). */
export const JUDGE_MODEL_ENV = "OXAGEN_LLM_JUDGE";

export const DEFAULT_ASSIST_CONFIG: AssistPipelineConfig = {
  enabled: true,
  promptEnhancement: { enabled: true, minAcceptableScore: DEFAULT_MIN_ACCEPTABLE_SCORE },
  judge: { enabled: true, defaultModel: DEFAULT_JUDGE_MODEL, mustDifferFromWorker: true },
  survey: {
    enabled: true,
    maxQuestions: 3,
    alwaysAllowFreeText: true,
    preferBestPracticeOverAsking: true,
  },
};

/**
 * Resolve the effective assist-pipeline config: user overrides from `config.json`
 * layered over {@link DEFAULT_ASSIST_CONFIG}. Pure over its `patch` argument so
 * tests can exercise the merge without touching the filesystem.
 */
export function mergeAssistConfig(patch?: AssistPipelineConfigPatch): AssistPipelineConfig {
  const d = DEFAULT_ASSIST_CONFIG;
  return {
    enabled: patch?.enabled ?? d.enabled,
    promptEnhancement: { ...d.promptEnhancement, ...patch?.promptEnhancement },
    judge: { ...d.judge, ...patch?.judge },
    survey: { ...d.survey, ...patch?.survey },
  };
}

/** The effective assist-pipeline config for this process. */
export function readAssistConfig(): AssistPipelineConfig {
  return mergeAssistConfig(readConfig().pipeline);
}

/**
 * The judge model slug: env override → configured default → baked-in default.
 * Env wins so a developer can retarget the judge for a whole shell without
 * editing config.
 */
export function resolveJudgeModel(configured?: string): string {
  return process.env[JUDGE_MODEL_ENV] ?? configured ?? DEFAULT_JUDGE_MODEL;
}
