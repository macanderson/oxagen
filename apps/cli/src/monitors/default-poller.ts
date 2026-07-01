/**
 * The default, GitHub-backed {@link TargetPoller} (pipeline Group 5).
 *
 * `BackgroundMonitorService` has no automatic shell-out default — its `poll`
 * dependency is required so a caller must explicitly choose an implementation.
 * This module is that real implementation: it shells out to the GitHub CLI
 * (`gh`) to check a `gh_actions_run`, `pull_request`, or `ci_job` target, and
 * only resolves once the run/check has reached a terminal state, retrying at
 * `pollIntervalSeconds` cadence in between. Wire it in explicitly (e.g. by
 * Group 6) via `new BackgroundMonitorService({ poll: createGhTargetPoller() })`.
 *
 * The process-execution step is itself injectable ({@link DefaultPollerDeps.exec})
 * so this module's parsing/looping logic is unit-testable without ever
 * spawning a real `gh` process — the unit-test path never shells out.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPollIntervalSeconds } from "./config.js";
import type { MonitorDispatchInput, TargetPollResult, TargetPoller } from "./types.js";

const execFileAsync = promisify(execFile);

/** Executes a CLI command and resolves with its stdout. Defaults to a real spawn. */
export type Exec = (
  command: string,
  args: string[],
  options: { signal: AbortSignal },
) => Promise<string>;

async function execGh(command: string, args: string[], options: { signal: AbortSignal }): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { signal: options.signal });
  return stdout;
}

/** Injectable dependencies for {@link createGhTargetPoller}. */
export interface DefaultPollerDeps {
  /** Runs a CLI command. Defaults to a real `child_process.execFile`. */
  exec?: Exec;
}

/** The `gh` subcommand + JSON fields to check for a given target type. */
function ghArgsFor(target: MonitorDispatchInput): string[] {
  switch (target.targetType) {
    case "pull_request":
      return ["pr", "view", target.targetId, "--json", "state,statusCheckRollup"];
    case "gh_actions_run":
    case "ci_job":
    default:
      return ["run", "view", target.targetId, "--json", "status,conclusion"];
  }
}

/** The shape this module expects back from `gh ... --json ...`. */
interface GhCheckPayload {
  status?: string;
  conclusion?: string | null;
  state?: string;
}

const TERMINAL_STATUSES = new Set(["completed", "done", "closed", "merged"]);

/**
 * Parse one `gh` JSON response. Returns `null` when the target is still in
 * flight (keep polling); otherwise returns the terminal {@link TargetPollResult}.
 */
function parseGhOutput(raw: string): TargetPollResult | null {
  let payload: GhCheckPayload;
  try {
    payload = JSON.parse(raw) as GhCheckPayload;
  } catch {
    return {
      status: "failed",
      identifiedProblem: false,
      note: "gh returned output that was not valid JSON",
    };
  }

  const status = (payload.status ?? payload.state ?? "").toLowerCase();
  if (status && !TERMINAL_STATUSES.has(status)) return null; // still running

  const conclusion = payload.conclusion?.toLowerCase();
  if (conclusion === "success" || status === "merged") return { status: "succeeded" };

  return {
    status: "failed",
    identifiedProblem: Boolean(conclusion),
    note: conclusion
      ? `gh reported conclusion="${conclusion}"`
      : "gh reported a terminal state with no success conclusion",
  };
}

/**
 * Builds a `TargetPoller` backed by the GitHub CLI. One call to the returned
 * poller resolves only once the target is terminal, checking at
 * `target.pollIntervalSeconds ?? getPollIntervalSeconds()` cadence.
 */
export function createGhTargetPoller(deps: DefaultPollerDeps = {}): TargetPoller {
  const exec = deps.exec ?? execGh;
  return async (target, signal) => {
    const intervalMs = (target.pollIntervalSeconds ?? getPollIntervalSeconds()) * 1000;
    for (;;) {
      if (signal.aborted) {
        return { status: "failed", identifiedProblem: false, note: "monitor poll aborted" };
      }
      const raw = await exec("gh", ghArgsFor(target), { signal });
      const parsed = parseGhOutput(raw);
      if (parsed) return parsed;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };
}
