/**
 * `oxagen router …` — the Verified-Outcome Market Router surface.
 *
 * The router turns model selection into a learned, economic decision: for each
 * task class it reads Oxagen's own observed outcomes (verified-success rate and
 * cost per model) and routes the work to the cheapest model that clears a
 * verified-success threshold, escalating tiers when the judge rejects a round.
 *
 *   router stats    — the Pareto read: per (task class, model) samples, verified
 *                     rate, avg cost/latency, plus the cheapest-clearing model
 *                     per class.
 *   router preview  — dry-run the decision for a prompt (changes nothing).
 *   router policy   — get / set the governed policy (mode + tunables).
 *
 * All calls go through the shared org-scoped API client in lib/api.ts. GET routes
 * use apiGetOrThrow, POST routes use apiPostOrThrow. Output discipline mirrors the
 * eval command: --json emits the exact contract payload; pretty mode renders a
 * table; failures are uniform stderr error lines.
 */
import { apiGetOrThrow, apiPostOrThrow, printTable } from "../lib/api.js";
import { formatUsd } from "../agent/rate-card.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

// ── Output shapes (mirror the router.* contract outputs) ─────────────────────

type RoutingMode = "off" | "shadow" | "enforce";

interface RoutingPolicyOut {
  mode: RoutingMode;
  successThreshold: number;
  minSamples: number;
  windowDays: number;
  escalateOnRejection: boolean;
  source?: "workspace" | "org" | "default";
  scope?: "org" | "workspace";
}

interface RoutingStatRow {
  taskClass: string;
  model: string;
  tier: string;
  samples: number;
  verifiedCount: number;
  verifiedRate: number;
  avgCostUsdMicros: number;
  avgLatencyMs: number;
  lastSeen: string;
}

interface RoutingClassSummary {
  taskClass: string;
  cheapestEligibleModel: string | null;
  verifiedRate: number | null;
  avgCostUsdMicros: number | null;
  candidateCount: number;
  eligibleCount: number;
}

interface RoutingStatsOut {
  rows: RoutingStatRow[];
  summary: RoutingClassSummary[];
  window: { windowDays: number; minSamples: number; successThreshold: number };
}

interface MarketCandidate {
  model: string;
  verifiedRate: number;
  samples: number;
  avgCostUsdMicros: number;
  eligible: boolean;
  reason: string;
}

interface RoutingDecisionOut {
  tier: string;
  model: string;
  rationale: string;
  source: "market" | "deterministic-fallback";
  taskClass: string;
  candidates: MarketCandidate[];
  policySnapshot: RoutingPolicyOut;
}

const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;
const usd = (micros: number): string => formatUsd(micros / 1_000_000);
const short = (model: string): string => model.split("/").pop() ?? model;

// ── router stats ─────────────────────────────────────────────────────────────

export async function routerStats(
  opts: {
    taskClass?: string;
    window?: number;
    minSamples?: number;
    json?: boolean;
  } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: RoutingStatsOut;
  try {
    result = await apiGetOrThrow<RoutingStatsOut>("router/stats", {
      task_class: opts.taskClass,
      window_days: opts.window,
      min_samples: opts.minSamples,
    });
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  if (cmd.isJson) {
    cmd.data(result);
    return;
  }
  const { rows, summary, window } = result;
  writer.write(
    `Observed outcomes — last ${window.windowDays}d, ≥${window.minSamples} samples, bar ${pct(window.successThreshold)}`,
  );
  writer.write("");
  if (rows.length === 0) {
    writer.write(
      "No routing outcomes recorded yet. Outcomes accrue as agents run under a shadow/enforce policy.",
    );
    return;
  }
  printTable(
    ["TASK CLASS", "MODEL", "TIER", "N", "VERIFIED", "AVG COST", "AVG LAT"],
    rows.map((r) => [
      r.taskClass,
      short(r.model),
      r.tier,
      String(r.samples),
      pct(r.verifiedRate),
      usd(r.avgCostUsdMicros),
      `${Math.round(r.avgLatencyMs)}ms`,
    ]),
    writer,
  );
  writer.write("");
  writer.write("Cheapest model clearing the bar, per task class:");
  printTable(
    ["TASK CLASS", "CHEAPEST ELIGIBLE", "VERIFIED", "AVG COST", "ELIGIBLE"],
    summary.map((s) => [
      s.taskClass,
      s.cheapestEligibleModel ? short(s.cheapestEligibleModel) : "— none —",
      s.verifiedRate != null ? pct(s.verifiedRate) : "—",
      s.avgCostUsdMicros != null ? usd(s.avgCostUsdMicros) : "—",
      `${s.eligibleCount}/${s.candidateCount}`,
    ]),
    writer,
  );
}

// ── router preview ─────────────────────────────────────────────────────────────

export async function routerPreview(
  prompt: string,
  opts: {
    files?: number;
    crossPackage?: boolean;
    taskClass?: string;
    json?: boolean;
  } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: RoutingDecisionOut;
  try {
    result = await apiPostOrThrow<RoutingDecisionOut>("router/preview", {
      prompt,
      fileCount: opts.files,
      crossPackage: opts.crossPackage,
      taskClass: opts.taskClass,
    });
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  if (cmd.isJson) {
    cmd.data(result);
    return;
  }
  writer.write(
    `Task class: ${result.taskClass}  ·  decision: ${result.source}`,
  );
  writer.write(`→ ${short(result.model)} (${result.tier})`);
  writer.write(`  ${result.rationale}`);
  writer.write("");
  if (result.candidates.length === 0) {
    writer.write(
      "No observed candidates for this class — deterministic fallback used.",
    );
    return;
  }
  printTable(
    ["MODEL", "VERIFIED", "N", "AVG COST", "ELIGIBLE", "WHY"],
    result.candidates.map((c) => [
      short(c.model),
      pct(c.verifiedRate),
      String(c.samples),
      usd(c.avgCostUsdMicros),
      c.eligible ? "yes" : "no",
      c.reason,
    ]),
    writer,
  );
}

// ── router policy get ──────────────────────────────────────────────────────────

function renderPolicy(p: RoutingPolicyOut, writer: CommandWriter): void {
  writer.write(`mode                 ${p.mode}`);
  writer.write(`success threshold    ${pct(p.successThreshold)}`);
  writer.write(`min samples          ${p.minSamples}`);
  writer.write(`window               ${p.windowDays}d`);
  writer.write(`escalate on reject   ${p.escalateOnRejection ? "yes" : "no"}`);
  if (p.source) writer.write(`source               ${p.source}`);
  if (p.scope) writer.write(`scope                ${p.scope}`);
}

export async function routerPolicyGet(
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: RoutingPolicyOut;
  try {
    result = await apiGetOrThrow<RoutingPolicyOut>("router/policy");
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  if (cmd.isJson) {
    cmd.data(result);
    return;
  }
  writer.write("Effective market-router policy:");
  renderPolicy(result, writer);
}

// ── router policy set ──────────────────────────────────────────────────────────

export async function routerPolicySet(
  opts: {
    scope?: "org" | "workspace";
    mode?: RoutingMode;
    threshold?: number;
    minSamples?: number;
    window?: number;
    escalate?: boolean;
    json?: boolean;
  } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: RoutingPolicyOut;
  try {
    result = await apiPostOrThrow<RoutingPolicyOut>("router/policy/set", {
      scope: opts.scope,
      mode: opts.mode,
      successThreshold: opts.threshold,
      minSamples: opts.minSamples,
      windowDays: opts.window,
      escalateOnRejection: opts.escalate,
    });
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  if (cmd.isJson) {
    cmd.data(result);
    return;
  }
  writer.write("Market-router policy updated:");
  renderPolicy(result, writer);
}
