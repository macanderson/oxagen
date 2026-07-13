// Server-composed, opinionated multi-repo clone script for durable sandbox
// provisioning.
//
// The start handler prepends this script (via `&&`) before any user/preset
// setupCmd, so it runs ONCE at create time through the runner's setup_cmd
// channel. Two invariants make it safe:
//   1. Every interpolated value (owner/repo/branch/path) is single-quoted for
//      the shell AND validated to a safe charset at the contract layer — defense
//      in depth against injection.
//   2. The GitHub token is NEVER written into the script text. When a token is
//      available it rides the setup_env channel as $GITHUB_TOKEN and is only
//      *referenced* (the literal `${GITHUB_TOKEN}`) inside a double-quoted URL,
//      then scrubbed from .git/config immediately after the clone.

import { WORKSPACE_ROOT } from "@oxagen/sandbox";

/** The per-repo shape persisted on session metadata and accepted by the clone composer. */
export interface SessionRepoRef {
  owner: string;
  repo: string;
  branch?: string;
}

/**
 * Deterministic /work directory name per repo. The base name is the repo;
 * the first collision on a bare repo name is disambiguated with an `-<owner>`
 * suffix, and any further collision appends a numeric suffix — so the mapping is
 * always total and unique regardless of duplicate or same-named inputs.
 */
export function resolveRepoDirs(repos: readonly SessionRepoRef[]): string[] {
  const used = new Set<string>();
  return repos.map(({ owner, repo }) => {
    let dir = repo;
    if (used.has(dir)) dir = `${repo}-${owner}`;
    let n = 2;
    while (used.has(dir)) dir = `${repo}-${owner}-${n++}`;
    used.add(dir);
    return dir;
  });
}

export interface ComposeRepoCloneOptions {
  /** True when a GitHub token will be delivered as $GITHUB_TOKEN in setup_env. */
  hasToken: boolean;
}

/**
 * Compose the `&&`-chained shell script that clones every repo into /work.
 * Returns "" when there are no repos. The whole chain is joined with `&&` so a
 * failure at any step short-circuits the rest and exits non-zero, which the
 * runner surfaces as a 422 instead of returning a half-provisioned sandbox.
 *
 * With a token, clone URLs are `x-access-token:${GITHUB_TOKEN}@…` (private-repo
 * capable); without one, plain HTTPS (public repos still clone). Either way each
 * origin is rewritten to a token-free URL so no credential persists on disk.
 */
export function composeRepoCloneScript(
  repos: readonly SessionRepoRef[],
  { hasToken }: ComposeRepoCloneOptions,
): string {
  if (repos.length === 0) return "";
  const dirs = resolveRepoDirs(repos);
  const steps: string[] = [`mkdir -p ${WORKSPACE_ROOT}`];
  repos.forEach((r, i) => {
    const path = `${WORKSPACE_ROOT}/${dirs[i]!}`;
    // Token URL uses DOUBLE quotes so $GITHUB_TOKEN expands at runtime; owner/repo
    // are charset-validated so no shell-active char can appear inside. Only the
    // literal `${GITHUB_TOKEN}` is emitted — never the token value.
    const cloneUrl = hasToken
      ? `"https://x-access-token:\${GITHUB_TOKEN}@github.com/${r.owner}/${r.repo}.git"`
      : `'https://github.com/${r.owner}/${r.repo}.git'`;
    // Token-free origin so the credential never lingers in .git/config.
    const scrubUrl = `'https://github.com/${r.owner}/${r.repo}.git'`;
    const branchArgs = r.branch
      ? `--branch '${r.branch}' --single-branch `
      : "";
    steps.push(
      `git clone ${branchArgs}${cloneUrl} '${path}'`,
      `git -C '${path}' remote set-url origin ${scrubUrl}`,
    );
  });
  return steps.join(" && ");
}
