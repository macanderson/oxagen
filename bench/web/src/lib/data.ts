import type { AgentProfile, AgentId, EvalDef, Category } from "./types";

/**
 * Agent performance profiles. Multipliers are anchored to the Oxagen CLI
 * baseline (1.0x speed, 1.0x efficiency) and mirror the published comparison in
 * BENCHMARK_SYSTEM.md. Colours follow the Oxagen ember/graphite palette.
 */
export const AGENTS: readonly AgentProfile[] = [
  {
    id: "oxagen-cli",
    name: "Oxagen CLI",
    tagline: "Baseline — graph-aware, metered, self-improving",
    speedMultiplier: 1.0,
    efficiencyMultiplier: 1.0,
    baseAccuracy: 0.92,
    color: "#F87854",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    tagline: "Strong reasoning, heavier context",
    speedMultiplier: 1.2,
    efficiencyMultiplier: 0.85,
    baseAccuracy: 0.89,
    color: "#A78BFA",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    tagline: "Fast suggestions, shallow context",
    speedMultiplier: 1.5,
    efficiencyMultiplier: 0.7,
    baseAccuracy: 0.82,
    color: "#34D399",
  },
  {
    id: "google-gemini",
    name: "Google Gemini",
    tagline: "Broad knowledge, mixed precision",
    speedMultiplier: 1.3,
    efficiencyMultiplier: 0.8,
    baseAccuracy: 0.87,
    color: "#60A5FA",
  },
] as const;

export const AGENTS_BY_ID: Readonly<Record<AgentId, AgentProfile>> = Object.fromEntries(
  AGENTS.map((a) => [a.id, a]),
) as Record<AgentId, AgentProfile>;

/**
 * The 12 evaluations across 4 categories (BENCHMARK_SYSTEM.md). Baselines are
 * the Oxagen CLI cost at medium difficulty; the engine scales them per-agent
 * and per-difficulty.
 */
export const EVALS: readonly EvalDef[] = [
  // Speed (2)
  {
    id: "simple-file-edit",
    name: "Simple File Edit",
    category: "speed",
    description: "Rename a symbol and update its TypeScript references.",
    baseDurationMs: 4200,
    baseTokens: 1800,
  },
  {
    id: "self-improvement",
    name: "Self-Improvement",
    category: "speed",
    description: "Learning curve across 5 repeated tasks.",
    baseDurationMs: 9800,
    baseTokens: 5200,
  },
  // Efficiency (3)
  {
    id: "context-retrieval",
    name: "Context Retrieval",
    category: "efficiency",
    description: "Find the relevant files in a large codebase.",
    baseDurationMs: 6100,
    baseTokens: 3400,
  },
  {
    id: "token-efficiency",
    name: "Token Efficiency",
    category: "efficiency",
    description: "Complete the task with minimal token spend.",
    baseDurationMs: 5200,
    baseTokens: 2600,
  },
  {
    id: "performance-optimization",
    name: "Performance Optimization",
    category: "efficiency",
    description: "Speed up a hot path without changing behavior.",
    baseDurationMs: 8700,
    baseTokens: 4800,
  },
  // Accuracy (3)
  {
    id: "bug-fix",
    name: "Bug Fix Challenge",
    category: "accuracy",
    description: "Identify and fix a non-obvious defect.",
    baseDurationMs: 7400,
    baseTokens: 4100,
  },
  {
    id: "multi-file-refactor",
    name: "Multi-File Refactor",
    category: "accuracy",
    description: "Apply a consistent change across many files.",
    baseDurationMs: 11200,
    baseTokens: 6400,
  },
  {
    id: "api-design",
    name: "API Design & Implementation",
    category: "accuracy",
    description: "Design and implement REST endpoints.",
    baseDurationMs: 10400,
    baseTokens: 5800,
  },
  // Quality (4)
  {
    id: "type-safety",
    name: "TypeScript Type Safety",
    category: "quality",
    description: "Implement a correctly-typed generic utility.",
    baseDurationMs: 6800,
    baseTokens: 3600,
  },
  {
    id: "error-handling",
    name: "Error Handling & Recovery",
    category: "quality",
    description: "Handle the full set of failure scenarios robustly.",
    baseDurationMs: 7100,
    baseTokens: 3900,
  },
  {
    id: "integration-testing",
    name: "Integration Testing",
    category: "quality",
    description: "Write comprehensive integration test coverage.",
    baseDurationMs: 9600,
    baseTokens: 5100,
  },
  {
    id: "documentation",
    name: "Code Documentation",
    category: "quality",
    description: "Generate accurate JSDoc for a module.",
    baseDurationMs: 5400,
    baseTokens: 2900,
  },
] as const;

export const EVALS_BY_ID: Readonly<Record<string, EvalDef>> = Object.fromEntries(
  EVALS.map((e) => [e.id, e]),
);

export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  speed: "Speed",
  efficiency: "Efficiency",
  accuracy: "Accuracy",
  quality: "Quality",
};

export const CATEGORY_ORDER: readonly Category[] = ["speed", "efficiency", "accuracy", "quality"];
