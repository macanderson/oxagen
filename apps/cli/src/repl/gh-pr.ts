/**
 * Best-effort, non-blocking PR-number lookup via the `gh` CLI. Separated from
 * git-info.ts (which is deliberately subprocess-free and synchronous) because
 * this is the one piece of REPO panel data that genuinely can't be read off
 * disk — GitHub's PR state isn't in `.git` — so it has to shell out and hit
 * the network. Never throws and never hangs the caller: `gh` missing, no PR
 * for the branch, a network error, or a slow response all resolve to `null`
 * within {@link GH_PR_TIMEOUT_MS}.
 */
import { execFile } from "node:child_process";

/** Hard cap so a slow/hanging `gh` invocation can never leave a caller waiting indefinitely. */
export const GH_PR_TIMEOUT_MS = 5000;

/**
 * Resolves the open PR number for `branch` in the repo at `cwd`, or `null`
 * when there isn't one / `gh` isn't installed or authenticated / the call
 * fails or times out. Always resolves (never rejects).
 */
export function fetchPrNumber(
  cwd: string,
  branch: string,
): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "view", branch, "--json", "number", "--jq", ".number"],
      { cwd, timeout: GH_PR_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          resolve(null); // gh missing, no PR for this branch, auth/network failure, or timeout
          return;
        }
        const n = Number(String(stdout).trim());
        resolve(Number.isFinite(n) && n > 0 ? n : null);
      },
    );
  });
}
