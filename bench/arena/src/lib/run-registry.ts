/**
 * Run Registry — real, guarded benchmark execution.
 *
 * The web dashboard's "Start Benchmark" button drives THIS module. Each run
 * spawns the real `scripts/run-benchmark.ts` CLI (one child process per enabled
 * agent), tracks it, streams its stdout/stderr to a per-run log file, and lets
 * the UI poll status and cancel. There is no simulation here.
 *
 * GUARDRAILS (the "$186 lesson" — orphaned in-container agents kept spending):
 *   1. `dryRun` defaults to true at every layer; a real run must be explicit.
 *   2. Per-agent budget is hard-capped at MAX_BUDGET_PER_AGENT.
 *   3. Children are spawned as process-group leaders (`detached: true`) so
 *      `cancelRun` / `pnpm bench:kill` can tear down the WHOLE tree
 *      (tsx → runner → CLI → any container the runner launched), not just the
 *      top process.
 *
 * State lives on `globalThis` so it survives Next.js dev HMR module reloads
 * (route handlers run in the single `next dev` server process).
 */

import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

import { sanitizedEnv } from "./env";
import type { AgentType } from "./types";

/** Hard ceiling on per-agent budget accepted from the web UI (USD). */
export const MAX_BUDGET_PER_AGENT = Number(process.env.ARENA_MAX_BUDGET ?? 50);

/** Task categories the UI can request. "smoke" maps to the CLI's default set. */
export const RUN_CATEGORIES = [
  "smoke",
  "bug-fix",
  "feature-implementation",
  "refactoring",
  "testing",
] as const;
export type RunCategory = (typeof RUN_CATEGORIES)[number];

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunJob {
  agent: AgentType;
  model: string;
  status: JobStatus;
  pid: number | null;
  exitCode: number | null;
}

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface RunRecord {
  runId: string;
  createdAt: string;
  dryRun: boolean;
  category: RunCategory;
  budget: number;
  timeout: number;
  concurrent: number;
  status: RunStatus;
  jobs: RunJob[];
  logFile: string;
}

export interface StartRunInput {
  agents: { type: AgentType; model: string }[];
  category: RunCategory;
  budget: number;
  timeout: number;
  concurrent: number;
  dryRun: boolean;
}

interface RegistryState {
  runs: Map<string, RunRecord>;
  /** Live child handles, keyed by runId — never serialized to the client. */
  children: Map<string, ChildProcess[]>;
  seq: number;
}

const GLOBAL_KEY = "__ARENA_RUN_REGISTRY__";

function state(): RegistryState {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: RegistryState;
  };
  g[GLOBAL_KEY] ??= { runs: new Map(), children: new Map(), seq: 0 };
  return g[GLOBAL_KEY];
}

function runsDir(): string {
  const dir = join(process.cwd(), ".runs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function nextRunId(): string {
  const s = state();
  s.seq += 1;
  // Sortable, collision-free id: a wall-clock base plus a per-process sequence
  // so restarts never reuse a prior run's log filename.
  return `run-${Date.now().toString(36)}-${String(s.seq).padStart(3, "0")}`;
}

/**
 * Translate a run into concrete CLI arguments for one agent. "smoke" uses the
 * CLI's built-in default task set; every other category maps to `--filter`.
 */
function cliArgs(
  record: RunRecord,
  job: RunJob,
): string[] {
  const args = [
    "tsx",
    "scripts/run-benchmark.ts",
    "--agent",
    job.agent,
    "--model",
    job.model,
    "--budget",
    String(record.budget),
    "--timeout",
    String(record.timeout),
    "--concurrent",
    String(record.concurrent),
  ];
  if (record.category !== "smoke") {
    args.push("--filter", `category=${record.category}`);
  }
  if (record.dryRun) args.push("--dry-run");
  return args;
}

function log(record: RunRecord, line: string): void {
  try {
    appendFileSync(record.logFile, line.endsWith("\n") ? line : `${line}\n`);
  } catch {
    // A logging failure must never crash a run.
  }
}

function recomputeRunStatus(record: RunRecord): void {
  if (record.status === "cancelled") return;
  const anyRunning = record.jobs.some(
    (j) => j.status === "running" || j.status === "queued",
  );
  if (anyRunning) {
    record.status = "running";
    return;
  }
  record.status = record.jobs.every((j) => j.status === "succeeded")
    ? "succeeded"
    : "failed";
}

/**
 * Create and immediately start a run. Returns the record (already `running`).
 * The caller is responsible for having validated + budget-capped the input.
 */
export function startRun(input: StartRunInput): RunRecord {
  const runId = nextRunId();
  const logFile = join(runsDir(), `${runId}.log`);

  const record: RunRecord = {
    runId,
    createdAt: new Date().toISOString(),
    dryRun: input.dryRun,
    category: input.category,
    budget: input.budget,
    timeout: input.timeout,
    concurrent: input.concurrent,
    status: "running",
    jobs: input.agents.map((a) => ({
      agent: a.type,
      model: a.model,
      status: "queued",
      pid: null,
      exitCode: null,
    })),
    logFile,
  };

  const s = state();
  s.runs.set(runId, record);
  s.children.set(runId, []);

  log(
    record,
    `=== Arena run ${runId} — ${input.dryRun ? "DRY RUN" : "LIVE RUN"} — ` +
      `category=${input.category} budget=$${String(input.budget)} timeout=${String(input.timeout)}s ===`,
  );

  for (const job of record.jobs) {
    const args = cliArgs(record, job);
    log(record, `\n$ npx ${args.join(" ")}`);

    const child = spawn("npx", args, {
      cwd: process.cwd(),
      detached: true, // own process group → cancel can kill the whole tree
      // Strip pnpm-injected keys npm rejects, else `npx` warns to stderr on
      // every spawn (logged as `[<agent>!] npm warn Unknown env config …`).
      env: sanitizedEnv(),
    });

    job.pid = child.pid ?? null;
    job.status = "running";
    s.children.get(runId)?.push(child);

    child.stdout.on("data", (d: Buffer) => {
      log(record, `[${job.agent}] ${d.toString().replace(/\n$/, "")}`);
    });
    child.stderr.on("data", (d: Buffer) => {
      log(record, `[${job.agent}!] ${d.toString().replace(/\n$/, "")}`);
    });
    child.on("error", (err: Error) => {
      log(record, `[${job.agent}] spawn error: ${err.message}`);
      job.status = "failed";
      recomputeRunStatus(record);
    });
    child.on("exit", (code, signal) => {
      job.exitCode = code;
      if (job.status === "cancelled") {
        // already terminal
      } else if (signal) {
        job.status = "cancelled";
      } else {
        job.status = code === 0 ? "succeeded" : "failed";
      }
      log(
        record,
        `[${job.agent}] exited: code=${String(code)} signal=${String(signal)} → ${job.status}`,
      );
      recomputeRunStatus(record);
    });
  }

  return record;
}

export function getRun(runId: string): RunRecord | undefined {
  return state().runs.get(runId);
}

export function listRuns(): RunRecord[] {
  return [...state().runs.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

/** Tail of the run's log file (bounded) so status polling stays cheap. */
export function readRunLog(runId: string, maxBytes = 16_384): string {
  const record = getRun(runId);
  if (!record || !existsSync(record.logFile)) return "";
  const size = statSync(record.logFile).size;
  const buf = readFileSync(record.logFile);
  return buf.subarray(Math.max(0, size - maxBytes)).toString("utf8");
}

/**
 * Terminate every child of a run by killing its process group, then mark the
 * run cancelled. Idempotent: cancelling a finished run is a no-op.
 */
export function cancelRun(runId: string): RunRecord | undefined {
  const s = state();
  const record = s.runs.get(runId);
  if (!record) return undefined;

  for (const child of s.children.get(runId) ?? []) {
    if (child.pid == null || child.exitCode != null) continue;
    try {
      // Negative pid → signal the whole process group (detached leader).
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // process already gone
      }
    }
  }
  for (const job of record.jobs) {
    if (job.status === "running" || job.status === "queued") {
      job.status = "cancelled";
    }
  }
  record.status = "cancelled";
  log(record, `\n=== run ${runId} cancelled ===`);
  return record;
}
