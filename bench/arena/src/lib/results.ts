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

import { validateBenchmarkResult, validateTrackerEntry } from "./schema";
import type { BenchmarkResult, TrackerEntry } from "./types";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

/**
 * Read + validate every measured result under `results/`, de-duped by id.
 *
 * Each run writes a `summary.json` (`{ metadata, results: [...] }`) **plus** one
 * flat file per result. The summary is the durable source of truth: every
 * result is pushed into `results[]` before its individual file is written, so
 * it survives even when a per-result write fails — e.g. a model id containing a
 * "/" (`anthropic/claude-opus-4.8`) would otherwise target a missing nested
 * directory and be lost from disk. We therefore expand `results[]` from
 * summaries as well as reading standalone result files, and de-dupe by
 * `result.id` so the copies that exist in both places are counted once.
 * Malformed files/entries are skipped. When no runs exist the caller gets an
 * empty array — the dashboard renders an honest empty state (Arena's core
 * "no simulated score" rule) rather than inventing numbers.
 */
export function readResults(): { result: BenchmarkResult; runDate: string }[] {
  const dir = resultsDir();
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { recursive: true }) as string[];
  const byId = new Map<string, { result: BenchmarkResult; runDate: string }>();

  for (const rel of entries) {
    if (!rel.endsWith(".json")) continue;
    const filePath = join(dir, rel);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }

    // A summary bundles many results under `.results[]` and carries a
    // run-level `metadata.runDate`; a standalone file is a single result.
    const summaryDate =
      isRecord(raw) && isRecord(raw.metadata) && typeof raw.metadata.runDate === "string"
        ? raw.metadata.runDate
        : undefined;
    const candidates: unknown[] =
      isRecord(raw) && Array.isArray(raw.results) ? raw.results : [raw];

    for (const candidate of candidates) {
      const parsed = validateBenchmarkResult(candidate);
      if (!parsed.success) continue;
      if (byId.has(parsed.data.id)) continue;
      byId.set(parsed.data.id, {
        result: parsed.data,
        runDate: summaryDate ?? runDateOf(parsed.data, filePath),
      });
    }
  }

  return [...byId.values()];
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

// ── Progress tracker (longitudinal history) ──────────────────────────────────

export interface HistorySeries {
  agentType: string;
  model: string;
  /** Points sorted oldest → newest. */
  points: TrackerEntry[];
  first: TrackerEntry;
  latest: TrackerEntry;
  /** latest.successRate − first.successRate (0 for a single point). */
  successRateDelta: number;
  /** latest.avgCost − first.avgCost. */
  costDelta: number;
}

function historyPath(): string {
  return join(process.cwd(), "tracker", "history.json");
}

/**
 * Read + validate the longitudinal tracker history that
 * `scripts/update-tracker.ts` writes to `tracker/history.json`, sorted oldest
 * → newest. A missing or malformed file yields an empty array (honest empty
 * state), and any individual malformed entry is skipped.
 */
export function readHistory(): TrackerEntry[] {
  const path = historyPath();
  if (!existsSync(path)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const entries: TrackerEntry[] = [];
  for (const candidate of raw) {
    const parsed = validateTrackerEntry(candidate);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

/** Group history into per-agent+model series with first/latest deltas. */
export function historySeries(entries: TrackerEntry[]): HistorySeries[] {
  const groups = new Map<string, TrackerEntry[]>();
  for (const entry of entries) {
    const key = `${entry.agentType}::${entry.model}`;
    const points = groups.get(key) ?? [];
    points.push(entry);
    groups.set(key, points);
  }

  return [...groups.values()].map((points) => {
    const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
    const first = sorted[0];
    const latest = sorted[sorted.length - 1];
    return {
      agentType: first.agentType,
      model: first.model,
      points: sorted,
      first,
      latest,
      successRateDelta: latest.successRate - first.successRate,
      costDelta: latest.avgCost - first.avgCost,
    };
  });
}

// ── Per-task breakdown (Compare page) ────────────────────────────────────────

export interface TaskBreakdownCell {
  agentType: string;
  model: string;
  runCount: number;
  successRate: number;
  avgCost: number;
}

export interface TaskBreakdownData {
  /** Ordered agent columns (type + model). */
  agents: { type: string; model: string; key: string }[];
  /** One row per task; `cells` keyed by agent column `key`. Missing = not run. */
  rows: { taskId: string; cells: Record<string, TaskBreakdownCell> }[];
}

/**
 * Build a task × agent matrix of success rate and average cost from measured
 * results — the drill-down the head-to-head summary doesn't show. Rows are
 * sorted by taskId; columns follow first-seen agent order.
 */
export function taskBreakdown(
  rows: { result: BenchmarkResult }[],
): TaskBreakdownData {
  const agentOrder: { type: string; model: string; key: string }[] = [];
  const agentSeen = new Set<string>();
  // taskId -> agentKey -> accumulator
  const matrix = new Map<
    string,
    Map<string, { type: string; model: string; n: number; successes: number; cost: number }>
  >();

  for (const { result } of rows) {
    const agentKey = `${result.agent.type}::${result.agent.model}`;
    if (!agentSeen.has(agentKey)) {
      agentSeen.add(agentKey);
      agentOrder.push({ type: result.agent.type, model: result.agent.model, key: agentKey });
    }

    const taskRow = matrix.get(result.taskId) ?? new Map();
    const cell = taskRow.get(agentKey) ?? {
      type: result.agent.type,
      model: result.agent.model,
      n: 0,
      successes: 0,
      cost: 0,
    };
    cell.n += 1;
    if (result.metrics.success) cell.successes += 1;
    cell.cost += result.metrics.totalCost;
    taskRow.set(agentKey, cell);
    matrix.set(result.taskId, taskRow);
  }

  const outRows = [...matrix.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([taskId, taskRow]) => {
      const cells: Record<string, TaskBreakdownCell> = {};
      for (const [agentKey, acc] of taskRow) {
        cells[agentKey] = {
          agentType: acc.type,
          model: acc.model,
          runCount: acc.n,
          successRate: acc.successes / acc.n,
          avgCost: acc.cost / acc.n,
        };
      }
      return { taskId, cells };
    });

  return { agents: agentOrder, rows: outRows };
}
