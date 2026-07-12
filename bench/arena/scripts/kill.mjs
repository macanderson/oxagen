#!/usr/bin/env node
/**
 * Stop the Arena bench dashboard AND any in-flight benchmark runs.
 *
 * `pnpm bench:kill` maps here. It does two things, both scoped to Arena so it
 * NEVER touches the main dev stack (apps/app on :3000, the API on :4000, etc.):
 *
 *   1. Kills the Next dev server by PORT (3300–3310 — the range dev.mjs picks
 *      from). Port-scoping is deliberate: a broad `pkill "next dev"` would take
 *      down every other Next server on the machine.
 *   2. Terminates any `scripts/run-benchmark.ts` children by PROCESS GROUP, so
 *      the agent CLIs they exec (which make the billable LLM calls) die too —
 *      not just the tsx wrapper. SIGTERM, brief grace, then SIGKILL.
 *
 * Arena runners exec agent CLIs in a tmp git workdir (no Docker), so there are
 * no trial containers to reap — unlike swe-bench/terminal-bench (bench/stop-bench.sh).
 */

import { execSync } from "node:child_process";

/** Run a command, capturing stdout; swallow non-zero exit (e.g. no match). */
function capture(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return "";
  }
}

/** Run a command for its side effect; swallow errors. */
function attempt(cmd) {
  try {
    execSync(cmd, { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    /* best effort */
  }
}

const ARENA_PORTS = Array.from({ length: 11 }, (_, i) => 3300 + i);

// ── 1. Dev server by port ───────────────────────────────────────────────────
const killedPorts = [];
for (const port of ARENA_PORTS) {
  const pids = capture(`lsof -ti tcp:${port}`).split(/\s+/).filter(Boolean);
  if (pids.length > 0) {
    attempt(`kill -9 ${pids.join(" ")}`);
    killedPorts.push(port);
  }
}

// ── 2. In-flight benchmark runs, killed by process group ─────────────────────
const RUN_MATCH = /scripts\/run-benchmark\.ts|bench-arena.*run:benchmark/;
function runBenchmarkPgids() {
  const pgids = new Set();
  for (const line of capture("ps -eo pgid=,command=").split("\n")) {
    if (RUN_MATCH.test(line) && !line.includes("kill.mjs")) {
      const pgid = line.trim().split(/\s+/)[0];
      if (pgid && /^\d+$/.test(pgid)) pgids.add(pgid);
    }
  }
  return [...pgids];
}

let pgids = runBenchmarkPgids();
const killedRuns = pgids.length;
for (const pgid of pgids) attempt(`kill -TERM -${pgid}`);

if (pgids.length > 0) {
  // Brief grace for graceful shutdown, then hard-kill anything left.
  attempt("sleep 1");
  for (const pgid of runBenchmarkPgids()) attempt(`kill -KILL -${pgid}`);
}

// ── Summary ──────────────────────────────────────────────────────────────────
if (killedPorts.length === 0 && killedRuns === 0) {
  console.log("bench:kill — nothing running (no Arena server on :3300–3310, no active runs).");
} else {
  if (killedPorts.length > 0) {
    console.log(`bench:kill — stopped Arena dev server on port(s): ${killedPorts.join(", ")}`);
  }
  if (killedRuns > 0) {
    console.log(`bench:kill — terminated ${killedRuns} in-flight benchmark run process group(s).`);
  }
}
