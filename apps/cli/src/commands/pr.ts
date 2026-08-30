/**
 * `oxagen pr` — never wonder where a PR stands.
 *
 *   oxagen pr status [<number>]         one-shot check verdict (exit 0 green / 1 failing / 2 pending)
 *   oxagen pr watch  [<number>]         stream status until a terminal state; offer to merge when green
 *   oxagen pr watch --merge             auto-merge (squash) the moment it's green
 *   oxagen pr fix    [<number>]         actively fix CI: diagnose, patch, push, repeat until green; ask before merging
 *   oxagen pr status --json             machine-readable
 *
 * Resolves the PR for the current branch when no number is given. All GitHub
 * access is via the `gh` CLI (inherits the user's auth); no token handling here.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as readline from "node:readline/promises";
import {
  summarizeChecks,
  isTerminal,
  formatSummary,
  type CheckRollupItem,
  type ChecksSummary,
} from "../lib/pr-monitor.js";
import {
  runFixToGreen,
  MAX_FAILING_CHECKS_TO_DIAGNOSE,
  type FixLoopResult,
  type FixPrView,
} from "../lib/pr-fix.js";
import { runGh, ghJson } from "./gh.js";
import { createPrFixRunner } from "../agent/pr-fix-runner.js";
import { requireSession } from "../lib/session.js";

const execFileAsync = promisify(execFile);

export interface PrOptions {
  json?: boolean;
  merge?: boolean;
  /** Poll interval seconds (watch). Default 30. */
  interval?: number;
  /** Max minutes to watch before giving up. Default 60. */
  timeout?: number;
}

export interface PrFixOptions {
  /** Max fix attempts before giving up. Default 3. */
  maxRounds?: number;
  /** Poll interval seconds while waiting on checks. Default 30. */
  interval?: number;
  /** Give up waiting on a single check run after this many minutes. Default 60. */
  timeout?: number;
  /** Merge once green without an interactive prompt (still an explicit opt-in — never implied). */
  yes?: boolean;
  /** Override the model used for fix attempts. */
  model?: string;
}

const out = (s: string): void => void process.stdout.write(s + "\n");
const err = (s: string): void => void process.stderr.write(s + "\n");

interface PrView {
  number: number;
  state: string;
  title: string;
  headRefName: string;
  url: string;
  statusCheckRollup?: CheckRollupItem[];
}

/** Fetch a PR view via `gh`. Number omitted ⇒ the current branch's PR. Exported for reuse by `pr fix`. */
export async function fetchPr(number?: string): Promise<PrView | null> {
  const args = [
    "pr",
    "view",
    ...(number ? [number] : []),
    "--json",
    "number,state,title,headRefName,url,statusCheckRollup",
  ];
  try {
    return await ghJson<PrView>(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no pull requests found|no default remote|could not resolve/i.test(msg))
      return null;
    throw e;
  }
}

function summaryOf(pr: PrView): ChecksSummary {
  return summarizeChecks(pr.statusCheckRollup ?? []);
}

/** Map a checks state to a process exit code (0 green, 1 failing, 2 pending/none). */
function exitCodeFor(summary: ChecksSummary): number {
  if (summary.state === "green") return 0;
  if (summary.state === "failing") return 1;
  return 2;
}

export async function handlePrStatus(
  number: string | undefined,
  opts: PrOptions,
): Promise<void> {
  const pr = await fetchPr(number);
  if (!pr) {
    err(
      "No pull request found for this branch. Open one, or pass a PR number.",
    );
    process.exitCode = 1;
    return;
  }
  const summary = summaryOf(pr);
  if (opts.json) {
    out(
      JSON.stringify({ number: pr.number, url: pr.url, ...summary }, null, 2),
    );
  } else {
    out(`PR #${pr.number} ${pr.title}`);
    out(`  ${formatSummary(summary)}`);
    if (summary.failing.length > 0) {
      for (const f of summary.failing)
        out(`    ✗ ${f.name}${f.url ? `  ${f.url}` : ""}`);
    }
  }
  process.exitCode = exitCodeFor(summary);
}

export async function handlePrWatch(
  number: string | undefined,
  opts: PrOptions,
): Promise<void> {
  const intervalMs = Math.max(5, opts.interval ?? 30) * 1000;
  const deadline = Date.now() + Math.max(1, opts.timeout ?? 60) * 60_000;

  let pr = await fetchPr(number);
  if (!pr) {
    err(
      "No pull request found for this branch. Open one, or pass a PR number.",
    );
    process.exitCode = 1;
    return;
  }
  const prNumber = String(pr.number);
  err(`Watching PR #${pr.number} — ${pr.title}`);

  let last = "";
  for (;;) {
    const summary = summaryOf(pr);
    const line = formatSummary(summary);
    if (line !== last) {
      err(`  ${line}`);
      last = line;
    }
    if (isTerminal(summary)) {
      if (summary.state === "green") {
        out(`PR #${pr.number} is GREEN — all ${summary.passed} checks passed.`);
        if (opts.merge) {
          // mergePr throws on failure — the exit code must follow the merge, not
          // the green checks, or a failed merge reports as a success.
          try {
            await mergePr(prNumber);
            process.exitCode = 0;
          } catch (e) {
            err(`Merge failed: ${e instanceof Error ? e.message : String(e)}`);
            process.exitCode = 1;
          }
        } else {
          out(
            `Merge it with:  oxagen pr watch ${pr.number} --merge   (or: gh pr merge ${pr.number} --squash)`,
          );
          process.exitCode = 0;
        }
      } else if (summary.state === "failing") {
        out(
          `PR #${pr.number} is FAILING: ${summary.failing.map((f) => f.name).join(", ")}`,
        );
        for (const f of summary.failing)
          if (f.url) out(`  ${f.name}: ${f.url}`);
        process.exitCode = 1;
      } else {
        out(`PR #${pr.number} has no checks to wait on.`);
        process.exitCode = 0;
      }
      return;
    }
    if (Date.now() >= deadline) {
      err(`Gave up after the watch window — still ${summary.pending} pending.`);
      process.exitCode = 2;
      return;
    }
    await sleep(intervalMs);
    pr = (await fetchPr(prNumber)) ?? pr;
  }
}

/** Squash-merge + delete the branch. Throws on failure — callers decide how to report it. */
async function mergePr(number: string): Promise<void> {
  await runGh(["pr", "merge", number, "--squash", "--delete-branch"]);
  out(`Merged PR #${number} (squash) and deleted the branch.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

// ── pr fix: the active fix-to-green loop ────────────────────────────────────

/** Parse a GitHub Actions job's run+job id out of its details URL (…/actions/runs/<run>/job/<job>). */
function parseRunAndJob(
  url: string | undefined,
): { runId: string; jobId: string } | null {
  if (!url) return null;
  const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(url);
  return m ? { runId: m[1] as string, jobId: m[2] as string } : null;
}

/** Keep a fetched failed-step log bounded — the tail is almost always where the real error is. */
function truncateLog(log: string, maxLines = 200): string {
  const lines = log.split("\n");
  if (lines.length <= maxLines) return log;
  return (
    `… (truncated, showing last ${maxLines} of ${lines.length} lines)\n` +
    lines.slice(-maxLines).join("\n")
  );
}

interface CheckAnnotation {
  message?: string;
  path?: string;
  start_line?: number;
}

/**
 * Fetch annotations + the failed-step log for the (bounded) leading set of
 * currently-failing checks, via `gh api .../check-runs/<job>/annotations` and
 * `gh run view --log-failed`. Best-effort per check — a check whose log can't
 * be fetched is simply omitted; an empty overall result tells the fix loop
 * there's nothing concrete to diagnose (its infra-flake / give-up signal).
 */
async function fetchFailingContext(
  pr: FixPrView,
  failing: ChecksSummary["failing"],
): Promise<string> {
  const repoMatch = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url);
  if (!repoMatch) return "";
  const [, owner, repo] = repoMatch;
  const sections: string[] = [];

  for (const check of failing.slice(0, MAX_FAILING_CHECKS_TO_DIAGNOSE)) {
    const ids = parseRunAndJob(check.url);
    if (!ids) continue;
    const lines: string[] = [`### ${check.name}`];

    try {
      const annotations = await ghJson<CheckAnnotation[]>([
        "api",
        `repos/${owner}/${repo}/check-runs/${ids.jobId}/annotations`,
      ]);
      for (const a of annotations.slice(0, 20)) {
        if (a.message)
          lines.push(
            `- ${a.path ? `${a.path}:${a.start_line ?? "?"}: ` : ""}${a.message}`,
          );
      }
    } catch {
      // best-effort — annotations aren't always populated
    }

    try {
      const { stdout } = await runGh(
        ["run", "view", ids.runId, "-j", ids.jobId, "--log-failed"],
        {
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      if (stdout.trim()) lines.push("", truncateLog(stdout));
    } catch {
      // best-effort — logs can be unavailable (expired artifact, cancelled run)
    }

    if (lines.length > 1) sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

/** `git status --porcelain` in `cwd`, parsed into relative paths (renames resolve to the new path). */
async function gitChangedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd,
  });
  return stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const arrow = line.indexOf(" -> ");
      const path = arrow >= 0 ? line.slice(arrow + 4) : line.slice(3);
      return path.trim().replace(/^"(.*)"$/, "$1");
    });
}

/**
 * Stage exactly `files` (pathspecs — never a blanket `add -A`, so the loop can
 * never sweep up something unrelated), commit, and push. `--no-verify` on
 * both: this is an unattended loop and must not wedge on a local hook (CI is
 * the real gate — that's what the surrounding loop is watching).
 */
async function commitAndPush(
  cwd: string,
  files: string[],
  message: string,
): Promise<void> {
  await execFileAsync("git", ["add", "--", ...files], { cwd });
  await execFileAsync("git", ["commit", "--no-verify", "-m", message], { cwd });
  await execFileAsync("git", ["push", "--no-verify"], { cwd });
}

async function currentGitBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd },
  );
  return stdout.trim();
}

/** y/N prompt before merging. Resolves `false` (never merge) when there's nobody to ask. */
async function confirmMerge(pr: FixPrView): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(`Merge PR #${pr.number} now? [y/N] `))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function reportFixResult(result: FixLoopResult): void {
  const label = result.pr ? `PR #${result.pr.number}` : "the PR";
  switch (result.outcome) {
    case "merged":
      out(`${label} is green and merged.`);
      process.exitCode = 0;
      return;
    case "merge-declined":
      out(
        `${label} is green. Not merged (declined) — merge it yourself with: gh pr merge ${result.pr?.number} --squash`,
      );
      process.exitCode = 0;
      return;
    case "merge-failed":
      err(`${label} is green but the merge failed — see above.`);
      process.exitCode = 1;
      return;
    case "no-change":
      err(
        `${label}: a fix round made no changes — stopping rather than loop forever.`,
      );
      process.exitCode = 1;
      return;
    case "unfixable":
      err(
        `${label}: couldn't fetch concrete failure context (looks like an infra flake) — stopping.`,
      );
      process.exitCode = 1;
      return;
    case "max-rounds":
      err(
        `${label}: still failing after ${result.rounds.length} fix round(s) — giving up.`,
      );
      process.exitCode = 1;
      return;
    case "timed-out":
      err(`${label}: gave up waiting for checks to finish.`);
      process.exitCode = 2;
      return;
    case "no-checks":
      out(`${label} has no checks to fix.`);
      process.exitCode = 0;
      return;
    case "no-pr":
      err(
        "No pull request found for this branch. Open one, or pass a PR number.",
      );
      process.exitCode = 1;
      return;
  }
}

/**
 * `oxagen pr fix` — poll CI, and on a failing check, diagnose + patch + push,
 * repeating until green (or a safety cap is hit) — then ask before merging.
 * Requires a session (it runs the engine agent); requires the current
 * checkout to actually be the PR's branch (this loop commits to `cwd`).
 */
export async function handlePrFix(
  number: string | undefined,
  opts: PrFixOptions,
): Promise<void> {
  const session = requireSession();
  const cwd = process.cwd();

  const pr0 = await fetchPr(number);
  if (!pr0) {
    err(
      "No pull request found for this branch. Open one, or pass a PR number.",
    );
    process.exitCode = 1;
    return;
  }

  // Safety: this loop commits + pushes to the CURRENT checkout — never let a
  // mismatched checkout (e.g. `pr fix 123` run from an unrelated branch) push
  // fixes to the wrong place.
  const branch = await currentGitBranch(cwd);
  if (branch !== pr0.headRefName) {
    err(
      `PR #${pr0.number}'s branch is "${pr0.headRefName}" but the current checkout is on "${branch}".\n` +
        `Check out ${pr0.headRefName} before running \`oxagen pr fix\` — it commits fixes to the current working tree.`,
    );
    process.exitCode = 1;
    return;
  }

  const runner = createPrFixRunner({
    session,
    cwd,
    model: opts.model,
    memoryExecutionRef: `cli:pr-fix-${pr0.number}-${Date.now()}`,
  });

  const result = await runFixToGreen(
    {
      fetchPr,
      fetchFailingContext,
      runFixer: runner.runFixer,
      changedFiles: () => gitChangedFiles(cwd),
      commitAndPush: (files, message) => commitAndPush(cwd, files, message),
      confirmMerge: opts.yes ? async () => true : confirmMerge,
      mergePr: (pr) => mergePr(String(pr.number)),
      sleep,
      onStatus: (line) => err(`  ${line}`),
      onRound: (round) => {
        out(`\nRound ${round.round}: fixing ${round.failing.join(", ")}`);
        const diagnosis = round.diagnosis.trim();
        out(
          diagnosis ? diagnosis.replace(/^/gm, "  ") : "  (no diagnosis text)",
        );
        out(
          round.filesChanged.length
            ? `  changed: ${round.filesChanged.join(", ")}`
            : "  no files changed",
        );
      },
    },
    {
      number: String(pr0.number),
      maxRounds: opts.maxRounds,
      pollIntervalMs: opts.interval
        ? Math.max(5, opts.interval) * 1000
        : undefined,
      pollTimeoutMs: opts.timeout
        ? Math.max(1, opts.timeout) * 60_000
        : undefined,
    },
  );

  // Mirror a lesson about the outcome — the same "wire memory in, mirror it
  // out" convention every other CLI agent path follows.
  const allFiles = [...new Set(result.rounds.flatMap((r) => r.filesChanged))];
  const lastDiagnosis =
    result.rounds.at(-1)?.diagnosis.trim().slice(0, 400) ?? "";
  if (result.outcome === "merged") {
    runner.rememberOutcome("bug-root-cause", {
      lesson: `oxagen pr fix resolved PR #${pr0.number}'s CI failures in ${result.rounds.length} round(s): ${lastDiagnosis}`,
      files: allFiles,
    });
  } else if (
    result.outcome === "max-rounds" ||
    result.outcome === "unfixable"
  ) {
    runner.rememberOutcome("gotcha", {
      lesson: `oxagen pr fix could not get PR #${pr0.number} green (${result.outcome}) after ${result.rounds.length} round(s): ${lastDiagnosis}`,
      files: allFiles,
    });
  }

  reportFixResult(result);
}
