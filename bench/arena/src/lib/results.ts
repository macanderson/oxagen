/**
 * Results reader — real measured benchmark data.
 *
 * Reads the JSON documents that `scripts/run-benchmark.ts` writes under
 * `results/<agent>-<timestamp>/<id>.json`, validates each against the shared
 * schema, and aggregates them. When no runs exist yet, callers get empty
 * arrays / zeroed stats — the dashboard renders an honest empty state rather
 * than inventing numbers (Arena's core "no simulated score" rule).
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

import { validateBenchmarkResult } from "./schema";
import type { BenchmarkResult } from "./types";

export interface RecentResultRow {
  id: string;
  taskId: string;
  agentType: string;
  model: string;
  success: boolean;
  durationSeconds: number;
  totalTokens: number;
  totalCost: number;
  runDate: string;
}

export interface QuickStatsData {
  totalResults: number;
  successRate: number;
  totalCost: number;
  avgDuration: number;
}

export interface AgentComparisonRow {
  type: string;
  model: string;
  runCount: number;
  successRate: number;
  avgDuration: number;
  avgCost: number;
  confidenceInterval: [number, number];
}

export interface AgentComparisonData {
  agents: AgentComparisonRow[];
  significantDifference: boolean;
}

function resultsDir(): string {
  return join(process.cwd(), "results");
}

/** A sortable run timestamp: measured provenance carries one; else file mtime. */
function runDateOf(result: BenchmarkResult, filePath: string): string {
  if (result.provenance.kind === "measured") return result.provenance.runDate;
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return "";
  }
}

/** Read + validate every result JSON under results/. Malformed files skipped. */
export function readResults(): { result: BenchmarkResult; runDate: string }[] {
  const dir = resultsDir();
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { recursive: true }) as string[];
  const out: { result: BenchmarkResult; runDate: string }[] = [];

  for (const rel of entries) {
    if (!rel.endsWith(".json")) continue;
    // The per-run `summary.json` is not a BenchmarkResult — it fails validation
    // and is skipped, which is exactly what we want.
    const filePath = join(dir, rel);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    const parsed = validateBenchmarkResult(raw);
    if (!parsed.success) continue;
    out.push({ result: parsed.data, runDate: runDateOf(parsed.data, filePath) });
  }
  return out;
}

export function computeQuickStats(
  rows: { result: BenchmarkResult }[],
): QuickStatsData {
  const n = rows.length;
  if (n === 0) {
    return { totalResults: 0, successRate: 0, totalCost: 0, avgDuration: 0 };
  }
  let successes = 0;
  let totalCost = 0;
  let totalDuration = 0;
  for (const { result } of rows) {
    if (result.metrics.success) successes += 1;
    totalCost += result.metrics.totalCost;
    totalDuration += result.metrics.durationSeconds;
  }
  return {
    totalResults: n,
    successRate: successes / n,
    totalCost,
    avgDuration: totalDuration / n,
  };
}

export function recentResults(
  rows: { result: BenchmarkResult; runDate: string }[],
  limit = 10,
): RecentResultRow[] {
  return [...rows]
    .sort((a, b) => b.runDate.localeCompare(a.runDate))
    .slice(0, limit)
    .map(({ result, runDate }) => ({
      id: result.id,
      taskId: result.taskId,
      agentType: result.agent.type,
      model: result.agent.model,
      success: result.metrics.success,
      durationSeconds: result.metrics.durationSeconds,
      totalTokens: result.metrics.totalTokens,
      totalCost: result.metrics.totalCost,
      runDate,
    }));
}

/** 95% Wilson score interval for a binomial proportion. */
function wilsonInterval(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [
    Math.max(0, (center - margin) / denom),
    Math.min(1, (center + margin) / denom),
  ];
}

export function agentComparison(
  rows: { result: BenchmarkResult }[],
): AgentComparisonData {
  const groups = new Map<
    string,
    { type: string; model: string; n: number; successes: number; cost: number; duration: number }
  >();

  for (const { result } of rows) {
    const key = `${result.agent.type}::${result.agent.model}`;
    const g = groups.get(key) ?? {
      type: result.agent.type,
      model: result.agent.model,
      n: 0,
      successes: 0,
      cost: 0,
      duration: 0,
    };
    g.n += 1;
    if (result.metrics.success) g.successes += 1;
    g.cost += result.metrics.totalCost;
    g.duration += result.metrics.durationSeconds;
    groups.set(key, g);
  }

  const agents: AgentComparisonRow[] = [...groups.values()].map((g) => ({
    type: g.type,
    model: g.model,
    runCount: g.n,
    successRate: g.successes / g.n,
    avgDuration: g.duration / g.n,
    avgCost: g.cost / g.n,
    confidenceInterval: wilsonInterval(g.successes, g.n),
  }));

  // Two agents "differ significantly" iff their 95% CIs don't overlap.
  let significantDifference = false;
  for (let i = 0; i < agents.length; i += 1) {
    for (let j = i + 1; j < agents.length; j += 1) {
      const a = agents[i];
      const b = agents[j];
      if (
        a.confidenceInterval[1] < b.confidenceInterval[0] ||
        b.confidenceInterval[1] < a.confidenceInterval[0]
      ) {
        significantDifference = true;
      }
    }
  }

  return { agents, significantDifference };
}
