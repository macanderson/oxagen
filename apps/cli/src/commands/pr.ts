/**
 * `oxagen pr` — never wonder where a PR stands.
 *
 *   oxagen pr status [<number>]         one-shot check verdict (exit 0 green / 1 failing / 2 pending)
 *   oxagen pr watch  [<number>]         stream status until a terminal state; offer to merge when green
 *   oxagen pr watch --merge             auto-merge (squash) the moment it's green
 *   oxagen pr status --json             machine-readable
 *
 * Resolves the PR for the current branch when no number is given. All GitHub
 * access is via the `gh` CLI (inherits the user's auth); no token handling here.
 */
import {
  summarizeChecks,
  isTerminal,
  formatSummary,
  type CheckRollupItem,
  type ChecksSummary,
} from "../lib/pr-monitor.js";
import { runGh, ghJson } from "./gh.js";

export interface PrOptions {
  json?: boolean;
  merge?: boolean;
  /** Poll interval seconds (watch). Default 30. */
  interval?: number;
  /** Max minutes to watch before giving up. Default 60. */
  timeout?: number;
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
          // mergePr throws on failure — don't let a fixed `process.exitCode = 0`
          // below stomp a real merge failure into a false success (it used to).
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
