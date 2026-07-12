/**
 * Arena Schema Validation
 *
 * Zod schemas for validating benchmark results and configurations.
 * Ensures data integrity and provenance tracking.
 */

import { z } from "zod";

/**
 * Provenance schema — every result must have one of these
 */
export const provenanceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("measured"),
    runId: z.string(),
    runDate: z.string(),
    gitSha: z.string(),
  }),
  z.object({
    kind: z.literal("reference"),
    source: z.string(),
    url: z.string().url(),
    date: z.string(),
  }),
  z.object({
    kind: z.literal("sample"),
    notes: z.string(),
  }),
]);

/**
 * Metrics schema
 */
export const metricsSchema = z.object({
  success: z.boolean(),
  criteriaPassed: z.array(z.string()),
  criteriaFailed: z.array(z.string()),
  durationSeconds: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative().optional(),
  totalCost: z.number().nonnegative(),
  toolCalls: z.number().nonnegative(),
  filesTouched: z.number().nonnegative(),
  linesAdded: z.number().int(),
  linesRemoved: z.number().int(),
  diffSize: z.number().nonnegative(),
  iterations: z.number().int().positive(),
  peakMemoryMb: z.number().nonnegative().optional(),
});

/**
 * Agent configuration schema
 */
export const agentConfigSchema = z.object({
  type: z.enum(["oxagen", "stella", "claude-code", "custom"]),
  model: z.string(),
  config: z.record(z.unknown()).optional(),
  budget: z.number().positive().optional(),
  timeout: z.number().positive().optional(),
});

/**
 * Benchmark result schema
 */
export const benchmarkResultSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  agent: agentConfigSchema,
  metrics: metricsSchema,
  provenance: provenanceSchema,
  prompt: z.string(),
  diff: z.string(),
  output: z.string(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Task schema
 */
export const taskSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum([
    "bug-fix",
    "feature-implementation",
    "refactoring",
    "testing",
    "documentation",
    "performance",
    "security",
    "integration",
  ]),
  difficulty: z.enum(["beginner", "intermediate", "advanced", "expert"]),
  ecosystem: z.enum([
    "typescript",
    "javascript",
    "python",
    "rust",
    "go",
    "java",
    "cpp",
    "csharp",
    "php",
    "ruby",
    "multi",
  ]),
  estimatedTokens: z.number().positive(),
  estimatedCost: z.number().nonnegative(),
  sourceRepo: z
    .object({
      owner: z.string(),
      name: z.string(),
      commit: z.string(),
    })
    .optional(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  startingPoint: z.string(),
  filesToModify: z.array(z.string()).optional(),
  testCommands: z.array(z.string()).optional(),
  tags: z.array(z.string()),
});

/**
 * Run configuration schema
 */
export const runConfigSchema = z.object({
  agents: z.array(agentConfigSchema).min(1),
  taskIds: z.array(z.string()).min(1),
  budget: z.number().positive().optional(),
  timeout: z.number().positive().optional(),
  concurrent: z.number().int().positive().optional(),
  outputDir: z.string().optional(),
  filters: z
    .object({
      categories: z.array(z.string()).optional(),
      difficulties: z.array(z.string()).optional(),
      ecosystems: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * Progress tracker entry schema — one longitudinal data point per
 * agent+model, written by `scripts/update-tracker.ts` into
 * `tracker/history.json` and read by the Progress page.
 */
export const trackerEntrySchema = z.object({
  date: z.string(),
  agentType: z.enum(["oxagen", "stella", "claude-code", "custom"]),
  model: z.string(),
  successRate: z.number().min(0).max(1),
  avgCost: z.number().nonnegative(),
  avgDuration: z.number().nonnegative(),
  tasksCompleted: z.number().int().nonnegative(),
  notes: z.string().optional(),
});

/**
 * Validation helpers
 */
export function validateBenchmarkResult(data: unknown) {
  return benchmarkResultSchema.safeParse(data);
}

export function validateTrackerEntry(data: unknown) {
  return trackerEntrySchema.safeParse(data);
}

export function validateTask(data: unknown) {
  return taskSchema.safeParse(data);
}

export function validateRunConfig(data: unknown) {
  return runConfigSchema.safeParse(data);
}
