/**
 * CI-wait awareness for the turn inactivity guard.
 *
 * Customer CI can legitimately run for hours, and a turn that is watching it
 * (e.g. `gh run watch` / `gh pr checks --watch` via the bash tool) can look
 * "stalled" to the progress guard. Rather than raising the guard window to
 * hours — which would leave genuinely hung turns undetected — the guard makes
 * one cheap call-out before aborting: if this turn recently ran a CI-watch
 * tool AND the current branch's checks are still pending, the wait is real and
 * the guard extends (cumulatively capped at `resolveCiWaitCapMs()`, 2h by
 * default). Green, red, no checks, or any probe failure ⇒ no extension — the
 * guard aborts exactly as before, so the hang backstop keeps its teeth.
 *
 * Wire-up: each turn creates one probe; `noteToolCall` observes every tool
 * call, and `probe` is handed to `makeStallDetector`'s `probe` option
 * (agent/timeouts.ts).
 */
import { execFile } from "node:child_process";
import { summarizeChecks, type CheckRollupItem } from "./pr-monitor.js";
import { debugLog } from "./debug-log.js";

/** Commands that mean "this turn is waiting on CI". */
const CI_WAIT_PATTERN =
  /\bgh\s+(?:run\s+(?:watch|view|list)|pr\s+(?:checks|view|status))\b|\bgh\b[^\n;|&]*--watch\b/;

/** True when a tool call is a CI watch/poll (a bash `gh` checks/run command). */
export function looksLikeCiWait(toolName: string, input: unknown): boolean {
  if (toolName !== "bash") return false;
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === "string" && CI_WAIT_PATTERN.test(command);
}

/** Runs a command and resolves stdout; rejects on non-zero exit. Injectable for tests. */
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<string>;

const defaultRunner: CommandRunner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        // A user shell exporting GH_FORCE_TTY / color config makes gh emit
        // ANSI-colored "JSON" even when piped, which breaks JSON.parse and
        // silently downgrades every probe to "not pending". Neutralize it.
        env: {
          ...process.env,
          GH_FORCE_TTY: "",
          NO_COLOR: "1",
          CLICOLOR: "0",
          CLICOLOR_FORCE: "0",
        },
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });

/** Strip ANSI escape sequences — belt-and-braces for colorized gh output. */
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** How long one probe call-out may take. Well under the guard window. */
const PROBE_CALL_TIMEOUT_MS = 15_000;

export interface CiWaitProbe {
  /** Observe a tool call; marks the turn as CI-waiting when it matches. */
  noteToolCall(toolName: string, input: unknown): void;
  /**
   * The pre-abort call-out: true ⇒ this turn was watching CI and the current
   * branch's checks are still pending, so the silence is legitimate — extend.
   * Never throws.
   */
  probe(): Promise<boolean>;
}

/**
 * Build the per-turn CI probe. The call-out asks `gh` for the current branch's
 * PR check rollup and treats a `pending` verdict as "still waiting". A turn
 * that never ran a CI-watch tool always probes false — an idle turn doesn't
 * get to hide behind someone else's CI.
 */
export function createCiWaitProbe(
  cwd: string,
  deps?: { run?: CommandRunner },
): CiWaitProbe {
  const run = deps?.run ?? defaultRunner;
  let sawCiWait = false;

  async function checksStillPending(): Promise<boolean> {
    const stdout = await run(
      "gh",
      ["pr", "view", "--json", "statusCheckRollup"],
      { cwd, timeoutMs: PROBE_CALL_TIMEOUT_MS },
    );
    const parsed = JSON.parse(stdout.replace(ANSI_PATTERN, "")) as {
      statusCheckRollup?: CheckRollupItem[] | null;
    };
    return summarizeChecks(parsed.statusCheckRollup ?? []).state === "pending";
  }

  return {
    noteToolCall(toolName, input) {
      if (!sawCiWait && looksLikeCiWait(toolName, input)) sawCiWait = true;
    },
    async probe() {
      if (!sawCiWait) return false;
      try {
        const pending = await checksStillPending();
        void debugLog("timeout", "[timeout] scope=ci_probe", { pending });
        return pending;
      } catch (err) {
        // No PR for the branch, gh missing/unauthenticated, network down — all
        // mean we cannot CONFIRM a live CI wait, so the guard keeps its bite.
        void debugLog("timeout", "[timeout] scope=ci_probe outcome=error", {
          error: err,
        });
        return false;
      }
    },
  };
}
