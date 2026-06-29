import { AGENTS_BY_ID, EVALS_BY_ID } from "./data";
import type {
  AgentId,
  AgentProfile,
  AgentSummary,
  BenchmarkRun,
  Difficulty,
  EvalDef,
  FailureMode,
  RunConfig,
  TaskResult,
} from "./types";

/**
 * mulberry32 — a tiny, fast, well-distributed seedable PRNG. We use it instead
 * of Math.random so a given RunConfig always yields the exact same results,
 * which makes the engine unit-testable and runs reproducible/shareable.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DifficultyFactor {
  /** Multiplies wall-clock and tokens. */
  readonly cost: number;
  /** Subtracted from base accuracy. */
  readonly accuracyPenalty: number;
}

const DIFFICULTY: Readonly<Record<Difficulty, DifficultyFactor>> = {
  easy: { cost: 0.7, accuracyPenalty: -0.04 },
  medium: { cost: 1.0, accuracyPenalty: 0.0 },
  hard: { cost: 1.55, accuracyPenalty: 0.11 },
};

export const FAILURE_MODES: readonly FailureMode[] = ["wrong-answer", "timeout", "error"];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Symmetric jitter in [-magnitude, +magnitude) driven by the supplied RNG. */
function jitter(rng: () => number, magnitude: number): number {
  return (rng() * 2 - 1) * magnitude;
}

/** Compute a single agent×eval task result deterministically from the RNG. */
export function runTask(
  agent: AgentProfile,
  evalDef: EvalDef,
  difficulty: Difficulty,
  rng: () => number,
): TaskResult {
  const factor = DIFFICULTY[difficulty];

  const durationMs = Math.round(
    evalDef.baseDurationMs * agent.speedMultiplier * factor.cost * (1 + jitter(rng, 0.08)),
  );
  // Lower efficiency multiplier => more tokens for the same work.
  const tokens = Math.round(
    (evalDef.baseTokens / agent.efficiencyMultiplier) * factor.cost * (1 + jitter(rng, 0.08)),
  );

  const accuracy = clamp(
    agent.baseAccuracy - factor.accuracyPenalty + jitter(rng, 0.03),
    0.4,
    0.99,
  );

  const passRoll = rng();
  const passed = passRoll < accuracy;

  let failureMode: FailureMode | null = null;
  if (!passed) {
    const modeRoll = rng();
    const index = Math.min(FAILURE_MODES.length - 1, Math.floor(modeRoll * FAILURE_MODES.length));
    failureMode = FAILURE_MODES[index] ?? "error";
  }

  return {
    agentId: agent.id,
    evalId: evalDef.id,
    durationMs,
    tokens,
    accuracy,
    passed,
    failureMode,
  };
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Roll up per-task results into a ranked per-agent summary. The composite score
 * weights pass rate and accuracy most heavily, with speed and efficiency scored
 * relative to the best performer in the same run (so the fastest agent gets the
 * full speed weight and others are scaled down proportionally).
 */
export function summarize(
  results: readonly TaskResult[],
  agentIds: readonly AgentId[],
): AgentSummary[] {
  const perAgent = new Map<AgentId, TaskResult[]>();
  for (const id of agentIds) perAgent.set(id, []);
  for (const r of results) perAgent.get(r.agentId)?.push(r);

  const base = agentIds.map((agentId) => {
    const tasks = perAgent.get(agentId) ?? [];
    const passRate = tasks.length === 0 ? 0 : tasks.filter((t) => t.passed).length / tasks.length;
    const avgAccuracy = average(tasks.map((t) => t.accuracy));
    const totalTokens = tasks.reduce((sum, t) => sum + t.tokens, 0);
    const totalDurationMs = tasks.reduce((sum, t) => sum + t.durationMs, 0);
    const avgTokens = tasks.length === 0 ? 0 : totalTokens / tasks.length;
    const avgDurationMs = tasks.length === 0 ? 0 : totalDurationMs / tasks.length;
    return { agentId, passRate, avgAccuracy, totalTokens, totalDurationMs, avgTokens, avgDurationMs };
  });

  const fastest = Math.min(...base.map((b) => b.avgDurationMs).filter((v) => v > 0), Infinity);
  const leanest = Math.min(...base.map((b) => b.avgTokens).filter((v) => v > 0), Infinity);

  const scored = base.map((b) => {
    const speedScore = b.avgDurationMs > 0 && Number.isFinite(fastest) ? fastest / b.avgDurationMs : 0;
    const efficiencyScore = b.avgTokens > 0 && Number.isFinite(leanest) ? leanest / b.avgTokens : 0;
    const score =
      100 * (0.5 * b.passRate + 0.2 * b.avgAccuracy + 0.15 * speedScore + 0.15 * efficiencyScore);
    return { ...b, score };
  });

  // Rank by score descending; ties broken by pass rate then accuracy.
  const ranked = [...scored].sort(
    (a, b) => b.score - a.score || b.passRate - a.passRate || b.avgAccuracy - a.avgAccuracy,
  );

  const rankByAgent = new Map<AgentId, number>();
  ranked.forEach((entry, index) => rankByAgent.set(entry.agentId, index + 1));

  // Preserve the caller's agent order in the output, attaching computed rank.
  return scored.map((s) => ({
    agentId: s.agentId,
    avgAccuracy: s.avgAccuracy,
    passRate: s.passRate,
    totalTokens: s.totalTokens,
    avgTokens: s.avgTokens,
    totalDurationMs: s.totalDurationMs,
    avgDurationMs: s.avgDurationMs,
    score: s.score,
    rank: rankByAgent.get(s.agentId) ?? scored.length,
  }));
}

function resolveAgents(agentIds: readonly AgentId[]): AgentProfile[] {
  return agentIds.map((id) => {
    const agent = AGENTS_BY_ID[id];
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent;
  });
}

function resolveEvals(evalIds: readonly string[]): EvalDef[] {
  return evalIds.map((id) => {
    const evalDef = EVALS_BY_ID[id];
    if (!evalDef) throw new Error(`Unknown eval: ${id}`);
    return evalDef;
  });
}

/**
 * Run the full benchmark for the given config. Deterministic in `seed`: the RNG
 * is consumed in a fixed agent-major, eval-minor order so the same config always
 * produces byte-identical results.
 */
export function runBenchmark(config: RunConfig): BenchmarkRun {
  if (config.agentIds.length === 0) throw new Error("At least one agent is required");
  if (config.evalIds.length === 0) throw new Error("At least one evaluation is required");

  const agents = resolveAgents(config.agentIds);
  const evals = resolveEvals(config.evalIds);
  const rng = mulberry32(config.seed);

  const results: TaskResult[] = [];
  for (const agent of agents) {
    for (const evalDef of evals) {
      results.push(runTask(agent, evalDef, config.difficulty, rng));
    }
  }

  const summaries = summarize(results, config.agentIds);

  return {
    id: `run-${config.seed.toString(36)}-${config.difficulty}`,
    createdAtMs: 0,
    difficulty: config.difficulty,
    seed: config.seed,
    agentIds: config.agentIds,
    evalIds: config.evalIds,
    results,
    summaries,
  };
}
