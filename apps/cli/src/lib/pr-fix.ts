/**
 * `oxagen pr fix` — the active fix-to-green loop.
 *
 * Polls a PR's CI to a terminal state (reusing {@link summarizeChecks} /
 * {@link isTerminal} / {@link formatSummary} from pr-monitor.ts); on a FAILING
 * check, fetches the concrete failing-job context, runs ONE bounded
 * engine-agent turn to make the smallest fix, commits + pushes exactly the
 * files that changed, and re-watches CI. Repeats up to `maxRounds` times.
 * When green, it asks before merging — this loop NEVER merges without an
 * explicit yes (see {@link PrFixDeps.confirmMerge}).
 *
 * Every external effect — gh, git, the engine turn, the merge prompt — is
 * injected via {@link PrFixDeps}, so the control flow here is fully testable
 * without GitHub, git, or a model call: tests supply fakes for all of them
 * (a fake `fetchPr`, a fake `runFixer`, an in-memory `changedFiles`, …).
 * `commands/pr.ts` wires the real gh/git/engine implementations on top.
 */
import {
  summarizeChecks,
  isTerminal,
  formatSummary,
  type CheckRollupItem,
  type ChecksSummary,
} from "./pr-monitor.js";

/** The subset of `gh pr view --json ...` this loop needs. */
export interface FixPrView {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  statusCheckRollup?: CheckRollupItem[];
}

/** What ONE bounded engine-agent turn returned — the "fixer". */
export interface FixTurnResult {
  /** The model's diagnosis / summary of what it did (or why it couldn't). */
  text: string;
}

/** Run ONE bounded engine-agent turn against the given prompt. Tests inject a fake. */
export type FixRunner = (prompt: string) => Promise<FixTurnResult>;

/** What happened in one fix attempt — surfaced to the user as it completes. */
export interface FixRound {
  round: number;
  failing: string[];
  diagnosis: string;
  filesChanged: string[];
  committed: boolean;
}

export type FixOutcome =
  | "merged"
  | "merge-declined"
  | "merge-failed"
  | "no-pr"
  | "no-checks"
  | "no-change"
  | "unfixable"
  | "max-rounds"
  | "timed-out";

export interface FixLoopResult {
  outcome: FixOutcome;
  rounds: FixRound[];
  pr?: { number: number; url: string };
}

export interface PrFixDeps {
  /** Fetch the PR view. Number omitted ⇒ the current branch's PR. Same contract as commands/pr.ts's fetchPr. */
  fetchPr: (number?: string) => Promise<FixPrView | null>;
  /**
   * Fetch + format the concrete error context for the currently-failing
   * checks (job log / annotations). An empty/blank result is treated as
   * "nothing concrete to diagnose" (e.g. an infra flake with no real log) —
   * the loop stops rather than guessing.
   */
  fetchFailingContext: (
    pr: FixPrView,
    failing: ChecksSummary["failing"],
  ) => Promise<string>;
  /** Run ONE bounded engine-agent turn with the given prompt. */
  runFixer: FixRunner;
  /** Relative paths with pending changes in the working tree (e.g. `git status --porcelain`). */
  changedFiles: () => Promise<string[]>;
  /** Stage exactly `files` (pathspecs — never a blanket `add -A`) and commit + push. */
  commitAndPush: (files: string[], message: string) => Promise<void>;
  /** Ask the user y/N before merging. Must resolve `false` when it cannot ask (non-interactive). */
  confirmMerge: (pr: FixPrView) => Promise<boolean>;
  /** Squash-merge the PR. Only called after `confirmMerge` resolves `true`. */
  mergePr: (pr: FixPrView) => Promise<void>;
  /** Poll delay. A real `setTimeout` in production; tests inject an instant resolve. */
  sleep: (ms: number) => Promise<void>;
  /** Surface a completed round's diagnosis + what changed. */
  onRound?: (round: FixRound) => void;
  /** Surface a one-line status update (waiting / state changes), mirroring `pr watch`. */
  onStatus?: (line: string) => void;
}

export interface RunFixToGreenOptions {
  number?: string;
  /** Max fix attempts before giving up. Default 3. */
  maxRounds?: number;
  /** Poll interval while waiting for a terminal check state (ms). Default 30s. */
  pollIntervalMs?: number;
  /** Give up waiting for a terminal state after this long (ms). Default 2 hours. */
  pollTimeoutMs?: number;
}

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
// Customer CI legitimately runs for hours; polling is cheap (one gh call per
// 30s), so waiting 2h beats giving up on a slow-but-healthy pipeline. Matches
// the turn guard's CI-wait cap (agent/timeouts.ts resolveCiWaitCapMs).
const DEFAULT_POLL_TIMEOUT_MS = 2 * 60 * 60_000;

/** How many of the currently-failing checks to pull logs for — bounds prompt size on a wide matrix failure. */
export const MAX_FAILING_CHECKS_TO_DIAGNOSE = 3;

/** Poll `deps.fetchPr` until the checks reach a terminal state, or the timeout elapses. */
async function waitForTerminal(
  deps: PrFixDeps,
  number: string | undefined,
  pollIntervalMs: number,
  pollTimeoutMs: number,
): Promise<{ pr: FixPrView; summary: ChecksSummary } | null> {
  let pr = await deps.fetchPr(number);
  if (!pr) return null;
  const deadline = Date.now() + pollTimeoutMs;
  let last = "";
  for (;;) {
    const summary = summarizeChecks(pr.statusCheckRollup ?? []);
    const line = formatSummary(summary);
    if (line !== last) {
      deps.onStatus?.(line);
      last = line;
    }
    if (isTerminal(summary)) return { pr, summary };
    if (Date.now() >= deadline) return { pr, summary };
    await deps.sleep(pollIntervalMs);
    pr = (await deps.fetchPr(String(pr.number))) ?? pr;
  }
}

/** Classify a terminal(-ish) summary into an early-exit outcome, or `null` when it's failing (keep going). */
function classifyTerminal(
  summary: ChecksSummary,
): "timed-out" | "green" | "no-checks" | null {
  if (!isTerminal(summary)) return "timed-out";
  if (summary.state === "green") return "green";
  if (summary.state === "none") return "no-checks";
  return null;
}

/** Build the bounded fixer prompt from the failing checks + fetched log context. */
export function buildFixPrompt(
  pr: FixPrView,
  summary: ChecksSummary,
  context: string,
): string {
  return [
    `PR #${pr.number} "${pr.title}" is failing CI on: ${summary.failing.map((f) => f.name).join(", ")}.`,
    "",
    "Failing check output (may be truncated):",
    context.trim(),
    "",
    "Diagnose the root cause and make the SMALLEST possible fix in this checkout so the",
    "failing check(s) pass. Only touch files strictly necessary for this fix — do not",
    "refactor, reformat, or change anything unrelated. Do not commit or push; leave the",
    "fix as uncommitted changes in the working tree.",
  ].join("\n");
}

async function resolveMerge(
  deps: PrFixDeps,
  pr: FixPrView,
  rounds: FixRound[],
  prRef: { number: number; url: string },
): Promise<FixLoopResult> {
  const shouldMerge = await deps.confirmMerge(pr);
  if (!shouldMerge) return { outcome: "merge-declined", rounds, pr: prRef };
  try {
    await deps.mergePr(pr);
  } catch (e) {
    deps.onStatus?.(
      `Merge failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { outcome: "merge-failed", rounds, pr: prRef };
  }
  return { outcome: "merged", rounds, pr: prRef };
}

/**
 * Run the fix-to-green loop for one PR.
 *
 * Safety caps: at most `maxRounds` fix attempts; a round that changes nothing
 * stops immediately (`"no-change"`) rather than looping forever; a failing
 * check with no fetchable log context stops immediately (`"unfixable"` — the
 * infra-flake / "nothing concrete to diagnose" signal). Never merges without
 * `deps.confirmMerge` resolving `true`.
 */
export async function runFixToGreen(
  deps: PrFixDeps,
  options: RunFixToGreenOptions = {},
): Promise<FixLoopResult> {
  const maxRounds = Math.max(1, options.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const rounds: FixRound[] = [];

  const first = await waitForTerminal(
    deps,
    options.number,
    pollIntervalMs,
    pollTimeoutMs,
  );
  if (!first) return { outcome: "no-pr", rounds };
  let { pr, summary } = first;
  const prRef = { number: pr.number, url: pr.url };

  for (let round = 1; round <= maxRounds; round++) {
    const early = classifyTerminal(summary);
    if (early === "green") return await resolveMerge(deps, pr, rounds, prRef);
    if (early) return { outcome: early, rounds, pr: prRef };

    // summary.state === "failing" here.
    const context = await deps.fetchFailingContext(pr, summary.failing);
    if (!context.trim()) {
      deps.onStatus?.(
        "No failing-check log context available — nothing concrete to diagnose; stopping.",
      );
      return { outcome: "unfixable", rounds, pr: prRef };
    }

    const prompt = buildFixPrompt(pr, summary, context);
    const fixResult = await deps.runFixer(prompt);
    const filesChanged = await deps.changedFiles();

    const record: FixRound = {
      round,
      failing: summary.failing.map((f) => f.name),
      diagnosis: fixResult.text,
      filesChanged,
      committed: filesChanged.length > 0,
    };
    rounds.push(record);
    deps.onRound?.(record);

    if (filesChanged.length === 0) {
      return { outcome: "no-change", rounds, pr: prRef };
    }

    const names = summary.failing.map((f) => f.name).join(", ");
    await deps.commitAndPush(
      filesChanged,
      `fix(ci): round ${round} - address failing ${names} on PR #${pr.number}`,
    );

    const next = await waitForTerminal(
      deps,
      String(pr.number),
      pollIntervalMs,
      pollTimeoutMs,
    );
    if (!next) return { outcome: "no-pr", rounds, pr: prRef };
    ({ pr, summary } = next);
  }

  const finalOutcome = classifyTerminal(summary);
  if (finalOutcome === "green")
    return await resolveMerge(deps, pr, rounds, prRef);
  return { outcome: finalOutcome ?? "max-rounds", rounds, pr: prRef };
}
