/**
 * Internal bench list/replay commands — NOT part of the distributed `oxagen`
 * CLI (apps/cli). @oxagen/bench is a private package never shipped in the
 * product; these are invoked via `pnpm --filter @oxagen/bench list|replay`
 * (see cli.ts and this package's package.json scripts).
 *
 *   pnpm --filter @oxagen/bench list
 *   pnpm --filter @oxagen/bench list -- --type swe-bench -n 10
 *   pnpm --filter @oxagen/bench replay -- 2984       show the task + reproducing command
 *   pnpm --filter @oxagen/bench replay -- 2984 --run actually re-run it
 *
 * Add --json to either subcommand for machine-readable output.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { buildReplayEnv, formatEnvPrefix, runScriptFor } from "./replay-env";
import {
  getBenchResultByPublicId,
  getBenchRunByPublicId,
  listBenchResults,
} from "./query";
import type { BenchmarkRunResultRow, BenchType } from "./types";

export interface BenchListOptions {
  type?: string;
  limit?: string;
  json?: boolean;
}

export interface BenchReplayOptions {
  run?: boolean;
  json?: boolean;
}

const out = (s: string): void => void process.stdout.write(s + "\n");
const errOut = (s: string): void => void process.stderr.write(s + "\n");

function parsePublicId(arg: string | undefined): number | null {
  if (!arg) return null;
  const n = parseInt(arg.replace(/^#/, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `list [--type <bench_type>] [-n <limit>] [--json]` */
export async function handleBenchList(opts: BenchListOptions): Promise<void> {
  const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
  const rows = await listBenchResults({
    benchType: opts.type as BenchType | undefined,
    limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
  });

  if (opts.json) {
    out(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    out(
      `No bench results found${opts.type ? ` (bench_type=${opts.type})` : ""}.`,
    );
    return;
  }

  out(
    `  ${"#id".padStart(6)}  ${"task".padEnd(34)}${"type".padEnd(15)}${"reward".padStart(7)}` +
      `${"resolved".padStart(10)}${"tokens".padStart(9)}${"cost".padStart(9)}  date`,
  );
  for (const r of rows) {
    out(`  ${formatResultRow(r)}`);
  }
}

/** Compact token count for the list column: 0 -> "-", 506956 -> "507.0k", 2_400_000 -> "2.40M". */
function formatTokens(n: number): string {
  if (n <= 0) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatResultRow(r: BenchmarkRunResultRow): string {
  const resolved = r.resolved === 1 ? "yes" : "no";
  const task = r.task_id.length > 34 ? r.task_id.slice(0, 31) + "…" : r.task_id;
  return (
    `${("#" + r.public_id).padStart(6)}  ${task.padEnd(34)}${r.bench_type.padEnd(15)}` +
    `${r.reward.toFixed(2).padStart(7)}${resolved.padStart(10)}${formatTokens(r.tokens_total).padStart(9)}` +
    `${("$" + r.cost_usd.toFixed(2)).padStart(9)}  ${r.started_at}`
  );
}

/**
 * Walk upward from `startDir` for `bench/<benchType>/run.sh` — the marker for
 * an agent-arena checkout. That harness is NOT in this repo, so `--run` only
 * works when the command is invoked from somewhere inside (or below) a
 * checkout of https://github.com/macanderson/agent-arena.
 */
function findRunScript(
  benchType: BenchType,
  startDir: string = process.cwd(),
): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "bench", benchType, "run.sh");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `replay <public_id> [--run] [--json]` */
export async function handleBenchReplay(
  idArg: string | undefined,
  opts: BenchReplayOptions,
): Promise<void> {
  const publicId = parsePublicId(idArg);
  if (publicId === null) {
    errOut("Usage: pnpm --filter @oxagen/bench replay -- <public_id> [--run]");
    process.exitCode = 1;
    return;
  }

  const result = await getBenchResultByPublicId(publicId);
  if (!result) {
    errOut(`No bench result found with public_id #${publicId}.`);
    process.exitCode = 1;
    return;
  }

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(result.config || "{}") as Record<string, unknown>;
  } catch {
    // Malformed config column (shouldn't happen — ingestBenchResultsDir always
    // writes valid JSON) — fall back to an empty env rather than crashing.
  }
  const env = buildReplayEnv(config);
  const script = runScriptFor(result.bench_type);
  const command = `${formatEnvPrefix(env)} ${script}`.trim();

  if (opts.json) {
    out(JSON.stringify({ result, env, script, command }, null, 2));
    return;
  }

  const run = await getBenchRunByPublicId(result.run_public_id);
  out(`#${result.public_id} — ${result.task_id} (${result.bench_type})`);
  out(
    `  reward: ${result.reward}   resolved: ${result.resolved === 1 ? "yes" : "no"}   status: ${result.status}`,
  );
  out(
    `  tokens: ${formatTokens(result.tokens_total)}   cost: $${result.cost_usd.toFixed(2)}   duration: ${result.duration_s}s`,
  );
  out(
    `  run: #${result.run_public_id}${run ? ` (${run.dataset}, git ${run.git_sha || "unknown"})` : ""}`,
  );
  out("");
  out("Reproducing command:");
  out(`  ${command}`);

  if (!opts.run) {
    out("");
    out("Pass --run to execute it now.");
    return;
  }

  const scriptPath = findRunScript(result.bench_type);
  if (!scriptPath) {
    errOut("");
    errOut(
      `Could not find ${script} above ${process.cwd()} — the harness lives in a ` +
        "separate checkout (https://github.com/macanderson/agent-arena). Run this " +
        "from inside that checkout to use --run, or copy the command above and run " +
        "it there yourself.",
    );
    process.exitCode = 1;
    return;
  }

  out("");
  out(
    `==> --run: executing ${scriptPath} (inherits this terminal — output streams live)…`,
  );
  const exitCode = await runReplay(scriptPath, env);
  process.exitCode = exitCode;
}

/**
 * Run the reproducing script with inherited stdio so Docker/harbor progress
 * streams live to the operator's own terminal. A benchmark run can
 * legitimately take hours and the operator wants to watch it directly, the
 * same as if they'd typed `./run.sh` themselves.
 */
function runReplay(
  scriptPath: string,
  env: Record<string, string>,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(scriptPath, [], {
      cwd: dirname(scriptPath),
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", () => resolve(127)); // e.g. run.sh not executable
    child.on("close", (code, signal) => resolve(code ?? (signal ? 143 : 1)));
  });
}
