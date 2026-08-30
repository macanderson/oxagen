// Pure parsing helpers over already-loaded Harbor / oxagen artifacts — no
// filesystem access here (that lives in ingest.ts, which reads the files and
// hands their parsed JSON/text to these functions). Kept separate so the
// parsing logic is testable with plain fixtures, no fs or ClickHouse mocking.
//
// Shapes below mirror three artifact families produced by the agent-arena
// harness (https://github.com/macanderson/agent-arena), which runs Harbor
// with an Oxagen agent adapter. That adapter is the source of every
// `oxagen_*` field read here; keep these derivations in step with it.
//   1. Harbor's own run config.json / result.json / per-task result.json.
//   2. The SWE-bench verifier's report.json (FAIL_TO_PASS/PASS_TO_PASS + resolved).
//   3. The oxagen best-of-N JSONL trajectory (agent/oxagen.txt) — the
//      headless event stream from `oxagen solve --json` (see
//      resultEnvelope() in apps/cli/src/tui/best-of-n-view/index.tsx).

import {
  BENCH_TOOL_NAMES,
  type BenchTestSpec,
  type BenchToolCallCounts,
  type BenchToolName,
} from "./types";

// ---------------------------------------------------------------------------
// Harbor run config.json
// ---------------------------------------------------------------------------

export interface HarborRunConfig {
  agents?: Array<{ name?: string; model_name?: string }>;
  datasets?: Array<{ name?: string; task_names?: string[] | null }>;
}

/**
 * Derive a short agent name from Harbor's run config, e.g.
 * "oxagen_swe_bench:OxagenAgent" -> "oxagen". Mirrors the same derivation in
 * agent-arena's own eval normalizer, so the two ingestion paths (bench.*
 * tables here, eval_runs/eval_results there) never disagree on what a run's
 * agent is called.
 */
export function agentNameFromHarborConfig(config: HarborRunConfig): string {
  const name = config.agents?.[0]?.name;
  if (!name) return "unknown";
  if (name.includes(":")) {
    const cls = name.split(":").pop() ?? "";
    const stripped = cls.endsWith("Agent")
      ? cls.slice(0, -"Agent".length)
      : cls;
    return stripped.toLowerCase().replace(/_/g, "-") || "unknown";
  }
  return name;
}

// ---------------------------------------------------------------------------
// Harbor per-task result.json
// ---------------------------------------------------------------------------

export interface HarborTaskResult {
  task_name?: string;
  trial_name?: string;
  task_id?: { org?: string; name?: string };
  agent_info?: {
    name?: string;
    version?: string;
    model_info?: { name?: string; provider?: string };
  };
  agent_result?: {
    cost_usd?: number | null;
    n_input_tokens?: number | null;
    n_output_tokens?: number | null;
    n_cache_tokens?: number | null;
    metadata?: Record<string, unknown> | null;
  };
  verifier_result?: { rewards?: { reward?: number } };
  exception_info?: unknown;
  started_at?: string;
  finished_at?: string;
  agent_execution?: { started_at?: string; finished_at?: string };
}

/**
 * Bare task/instance id with the dataset namespace stripped, e.g.
 * "swe-bench/django__django-11099" -> "django__django-11099". Prefers the
 * structured `task_id.name`; falls back to splitting `task_name` on "/".
 */
export function bareTaskId(trial: HarborTaskResult): string {
  if (trial.task_id?.name) return trial.task_id.name;
  const taskName = trial.task_name ?? "";
  const slash = taskName.lastIndexOf("/");
  return slash >= 0 ? taskName.slice(slash + 1) : taskName;
}

/** Reward as a finite number, defaulting to 0 for a missing/malformed value. */
export function rewardOf(trial: HarborTaskResult): number {
  const r = trial.verifier_result?.rewards?.reward;
  return typeof r === "number" && Number.isFinite(r) ? r : 0;
}

/** A number when finite, else 0 — the shared coercion for nullable numeric result fields. */
function finiteOrZero(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function numberMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): number {
  const v = metadata?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** True when a numeric metadata key is present and finite (distinguishes "absent" from a real 0). */
function hasNumberMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  const v = metadata?.[key];
  return typeof v === "number" && Number.isFinite(v);
}

/** Per-modality token counts as reported by Harbor's built-in competitor adapters. */
export interface AgentSplitTokens {
  in: number;
  out: number;
  cache: number;
}

/**
 * The input/output/cache split from agent_result. Populated by Harbor's own
 * competitor adapters (claude-code, codex, aider); always 0 for the oxagen
 * adapter, which reports a single undifferentiated total in metadata instead
 * (see `agentTotalTokens`). Never sum these as a total — for oxagen runs that
 * sum is 0.
 */
export function agentSplitTokens(trial: HarborTaskResult): AgentSplitTokens {
  const ar = trial.agent_result;
  return {
    in: finiteOrZero(ar?.n_input_tokens),
    out: finiteOrZero(ar?.n_output_tokens),
    cache: finiteOrZero(ar?.n_cache_tokens),
  };
}

/**
 * Authoritative total token count for a trial. The oxagen adapter reports one
 * undifferentiated total in `agent_result.metadata.oxagen_total_tokens` (it
 * does not split input/output/cache), while competitor adapters report the
 * split. Prefer the metadata total when present, else fall back to the sum of
 * the split fields — the same normalization agent-arena's own summarizer does.
 */
export function agentTotalTokens(trial: HarborTaskResult): number {
  const meta = trial.agent_result?.metadata;
  if (hasNumberMetadata(meta, "oxagen_total_tokens")) {
    return numberMetadata(meta, "oxagen_total_tokens");
  }
  const split = agentSplitTokens(trial);
  return split.in + split.out + split.cache;
}

/**
 * Trial cost in USD from `agent_result.cost_usd`. Harbor DOES record this for
 * the oxagen agent — the adapter sets `context.cost_usd` from the CLI's usage
 * envelope. 0 when absent/malformed.
 */
export function agentCostUsd(trial: HarborTaskResult): number {
  return finiteOrZero(trial.agent_result?.cost_usd);
}

function stringMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const v = metadata?.[key];
  return typeof v === "string" ? v : "";
}

export interface BestOfNMetadata {
  nCandidates: number;
  winnerCandidateId: string;
  winnerFiles: number;
  winnerSteps: number;
}

/** Read the `oxagen_bestofn_*` fields the adapter stamps onto agent_result.metadata. */
export function bestOfNMetadata(trial: HarborTaskResult): BestOfNMetadata {
  const meta = trial.agent_result?.metadata;
  return {
    nCandidates: numberMetadata(meta, "oxagen_bestofn_candidates"),
    winnerCandidateId: stringMetadata(meta, "oxagen_bestofn_winner_id"),
    winnerFiles: numberMetadata(meta, "oxagen_bestofn_winner_files"),
    winnerSteps: numberMetadata(meta, "oxagen_bestofn_winner_steps"),
  };
}

/** Wall-clock seconds for the agent's execution phase, or 0 when timestamps are absent/unparseable. */
export function durationSeconds(trial: HarborTaskResult): number {
  const start = trial.agent_execution?.started_at ?? trial.started_at;
  const end = trial.agent_execution?.finished_at ?? trial.finished_at;
  if (!start || !end) return 0;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return 0;
  return Math.round((endMs - startMs) / 1000);
}

// ---------------------------------------------------------------------------
// SWE-bench verifier/report.json
// ---------------------------------------------------------------------------

interface HarborTestBucket {
  success?: string[];
  failure?: string[];
}

interface HarborVerifierReportEntry {
  resolved?: boolean;
  tests_status?: {
    FAIL_TO_PASS?: HarborTestBucket;
    PASS_TO_PASS?: HarborTestBucket;
  };
}

export type HarborVerifierReport = Record<string, HarborVerifierReportEntry>;

function uniqueUnion(bucket: HarborTestBucket | undefined): string[] {
  if (!bucket) return [];
  return [...new Set([...(bucket.success ?? []), ...(bucket.failure ?? [])])];
}

export interface ParsedVerifierReport {
  /** null when the report doesn't have an explicit `resolved` flag for this task. */
  resolved: boolean | null;
  testSpec: BenchTestSpec;
}

/**
 * Extract `resolved` + the FAIL_TO_PASS/PASS_TO_PASS test spec for one task
 * from a SWE-bench verifier report.json. The report is keyed by task id, but
 * report files are single-task (one key) — so when `taskId` isn't found
 * verbatim, this falls back to the report's only entry rather than giving up.
 */
export function parseVerifierReport(
  report: HarborVerifierReport | null | undefined,
  taskId: string,
): ParsedVerifierReport {
  if (!report)
    return { resolved: null, testSpec: { FAIL_TO_PASS: [], PASS_TO_PASS: [] } };
  const entry = report[taskId] ?? Object.values(report)[0];
  if (!entry)
    return { resolved: null, testSpec: { FAIL_TO_PASS: [], PASS_TO_PASS: [] } };
  return {
    resolved: typeof entry.resolved === "boolean" ? entry.resolved : null,
    testSpec: {
      FAIL_TO_PASS: uniqueUnion(entry.tests_status?.FAIL_TO_PASS),
      PASS_TO_PASS: uniqueUnion(entry.tests_status?.PASS_TO_PASS),
    },
  };
}

// ---------------------------------------------------------------------------
// agent/oxagen.txt — best-of-N JSONL trajectory
// ---------------------------------------------------------------------------

const KNOWN_TOOL_NAMES = new Set<string>(BENCH_TOOL_NAMES);

export interface TrajectoryCandidate {
  id: string;
  model: string;
  steps: number;
  filesChanged: number;
  failed: boolean;
  isWinner: boolean;
  toolCalls: BenchToolCallCounts;
}

export interface ParsedTrajectory {
  problemStatement: string;
  winnerCandidateId: string;
  winnerFiles: number;
  candidates: TrajectoryCandidate[];
  /** Tool-call counts summed across every candidate. */
  aggregateToolCalls: BenchToolCallCounts;
}

const EMPTY_TRAJECTORY: ParsedTrajectory = {
  problemStatement: "",
  winnerCandidateId: "",
  winnerFiles: 0,
  candidates: [],
  aggregateToolCalls: {},
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Callers only ever pass a `label` already confirmed against KNOWN_TOOL_NAMES
// (see the "candidate-progress" case below), so the cast is safe and there's
// no second membership check to fall through here.
function bumpToolCall(counts: BenchToolCallCounts, tool: BenchToolName): void {
  counts[tool] = (counts[tool] ?? 0) + 1;
}

/**
 * Parse the headless best-of-N JSONL event stream: `start` (problem
 * statement), `candidate-start` (id -> model), `candidate-progress` (id,
 * label — a tool name for a tool call, or a "phase · detail" string we
 * ignore), and the final `result` event (winnerId, winnerFiles, and the
 * per-candidate steps/changedFiles/failed array). Malformed or unrecognised
 * lines are skipped rather than failing the whole parse — this is a live
 * process's tee'd stdout, not a validated wire format.
 */
export function parseTrajectory(text: string): ParsedTrajectory {
  if (!text.trim()) return EMPTY_TRAJECTORY;

  let problemStatement = "";
  const modelByCandidate = new Map<string, string>();
  const toolCallsByCandidate = new Map<string, BenchToolCallCounts>();
  const aggregateToolCalls: BenchToolCallCounts = {};
  let resultEvent: Record<string, unknown> | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    switch (parsed.type) {
      case "start":
        if (typeof parsed.prompt === "string") problemStatement = parsed.prompt;
        break;
      case "candidate-start":
        if (typeof parsed.id === "string" && typeof parsed.model === "string") {
          modelByCandidate.set(parsed.id, parsed.model);
        }
        break;
      case "candidate-progress": {
        const id = typeof parsed.id === "string" ? parsed.id : null;
        const label = typeof parsed.label === "string" ? parsed.label : null;
        if (!id || !label || !KNOWN_TOOL_NAMES.has(label)) break;
        const tool = label as BenchToolName;
        const bucket = toolCallsByCandidate.get(id) ?? {};
        bumpToolCall(bucket, tool);
        toolCallsByCandidate.set(id, bucket);
        bumpToolCall(aggregateToolCalls, tool);
        break;
      }
      case "result":
        resultEvent = parsed;
        break;
      default:
        break;
    }
  }

  if (!resultEvent) {
    return { ...EMPTY_TRAJECTORY, problemStatement, aggregateToolCalls };
  }

  const winnerCandidateId =
    typeof resultEvent.winnerId === "string" ? resultEvent.winnerId : "";
  const winnerFiles = Array.isArray(resultEvent.winnerFiles)
    ? resultEvent.winnerFiles.length
    : 0;
  const rawCandidates = Array.isArray(resultEvent.candidates)
    ? resultEvent.candidates
    : [];

  const candidates: TrajectoryCandidate[] = rawCandidates
    .filter(isRecord)
    .map((c) => {
      const id = typeof c.id === "string" ? c.id : "";
      return {
        id,
        model:
          typeof c.model === "string"
            ? c.model
            : (modelByCandidate.get(id) ?? ""),
        steps: typeof c.steps === "number" ? c.steps : 0,
        filesChanged: Array.isArray(c.changedFiles) ? c.changedFiles.length : 0,
        failed: c.failed === true,
        isWinner: id !== "" && id === winnerCandidateId,
        toolCalls: toolCallsByCandidate.get(id) ?? {},
      };
    });

  return {
    problemStatement,
    winnerCandidateId,
    winnerFiles,
    candidates,
    aggregateToolCalls,
  };
}

/** Calls recorded for ONE tool, 0 when it was never used — the source for the `code_graph_calls`/`grep_calls` columns. */
export function toolCallCount(
  counts: BenchToolCallCounts,
  tool: BenchToolName,
): number {
  return counts[tool] ?? 0;
}
