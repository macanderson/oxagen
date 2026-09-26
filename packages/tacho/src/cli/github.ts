/** Opt-in GitHub Git transport. Git receives a local lease, never a GitHub token. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { CliDeps } from "./deps";
import { shellQuote } from "./deps";
import { depsForHarness } from "./slot-deps";
import { type HostFile, readHostFile, writeHostFile } from "../host/host-file";
import { isWrappedHarness } from "../wire";

function git(
  deps: CliDeps,
  cwd: string,
  args: string[],
  allowMissing = false,
): string {
  const out = deps.exec("git", ["-C", cwd, ...args]);
  if (
    out.status !== 0 &&
    !(allowMissing && (out.status === 1 || out.status === 5))
  )
    throw new Error(out.stderr || "Git configuration failed");
  return out.stdout.trim();
}

/** Common Git config cannot bind different agent identities in sibling worktrees. */
function requireSingleWorktree(deps: CliDeps, cwd: string): void {
  const directory = git(deps, cwd, ["rev-parse", "--absolute-git-dir"]);
  const common = resolve(
    cwd,
    git(deps, cwd, ["rev-parse", "--git-common-dir"]),
  );
  const worktrees = git(deps, cwd, ["worktree", "list", "--porcelain"]);
  if (
    realpathSync(directory) !== realpathSync(common) ||
    worktrees.split("\n").filter((line) => line.startsWith("worktree "))
      .length !== 1
  ) {
    throw new Error(
      "GitHub custody requires a standalone checkout. Use a separate clone for this agent, or remove custody before adding worktrees.",
    );
  }
}

function setGitValues(
  deps: CliDeps,
  cwd: string,
  key: string,
  values: string[],
): void {
  if (values.length === 0) {
    git(deps, cwd, ["config", "--local", "--unset-all", key], true);
    return;
  }
  git(deps, cwd, ["config", "--local", "--replace-all", key, values[0]!]);
  for (const value of values.slice(1))
    git(deps, cwd, ["config", "--local", "--add", key, value]);
}

export function githubConfigure(
  options: {
    cwd: string;
    harness: string;
    repository: string;
    remove?: boolean;
  },
  rootDeps: CliDeps,
): void {
  // The repository's proxy belongs to the agent that hooks this harness.
  const deps = depsForHarness(rootDeps, options.harness);
  const host = readHostFile(deps.paths.hostFile);
  if (!host)
    throw new Error("Enroll this host before configuring GitHub custody");
  if (
    !isWrappedHarness(options.harness) ||
    !host.harnesses.includes(options.harness)
  )
    throw new Error(
      "Choose an enrolled harness: claude-code, codex, cursor, or stella",
    );
  if (
    !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(options.repository) ||
    [".", ".."].includes(options.repository.split("/")[1] ?? "")
  )
    throw new Error("Name the GitHub repository as owner/name");
  const cwd = resolve(options.cwd);
  git(deps, cwd, ["rev-parse", "--git-dir"]);
  const repository = options.repository.replace(/\.git$/, "");
  const url = `http://127.0.0.1:${host.port}/github/${repository}.git`;
  const helperKey = `credential.${url}.helper`;
  const pathKey = `credential.${url}.useHttpPath`;
  const helperBase = deps.runtime.credentialHelperCommand;
  if (!helperBase)
    throw new Error("This installation has no credential helper command");
  const helper = `!${helperBase.replace(/credential issue --harness claude-code$/, "github credential")} --harness ${shellQuote(options.harness, deps.platform)} --cwd ${shellQuote(cwd, deps.platform)}`;
  const existing = git(
    deps,
    cwd,
    ["config", "--local", "--get-all", helperKey],
    true,
  );
  if (existing && existing !== helper)
    throw new Error(
      "This repository already has a different GitHub proxy helper",
    );
  const receipts = host.github_repositories ?? [];
  const previous = receipts.find(
    (entry) => entry.cwd === cwd && entry.repository === repository,
  );
  if (options.remove) {
    const failures = restoreGithubRepositories(
      { ...host, github_repositories: previous ? [previous] : [] },
      deps,
    );
    if (failures.length) throw new Error(failures.join("\n"));
    writeHostFile(deps.paths.hostFile, {
      ...host,
      github_repositories: receipts.filter((entry) => entry !== previous),
    });
    deps.out(`GitHub proxy removed for ${repository}`);
    return;
  }
  requireSingleWorktree(deps, cwd);
  const accepted = new Set([
    `https://github.com/${repository}`,
    `https://github.com/${repository}.git`,
    `git@github.com:${repository}`,
    `git@github.com:${repository}.git`,
    `ssh://git@github.com/${repository}`,
    `ssh://git@github.com/${repository}.git`,
  ]);
  const configured = git(
    deps,
    cwd,
    ["config", "--local", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"],
    true,
  );
  const remotes = [...(previous?.remotes ?? [])];
  const byKey = new Map<string, string[]>();
  for (const line of configured.split("\n")) {
    const split = line.indexOf(" ");
    if (split < 0) continue;
    const key = line.slice(0, split),
      value = line.slice(split + 1);
    byKey.set(key, [...(byKey.get(key) ?? []), value]);
  }
  for (const [key, values] of byKey) {
    const saved = remotes.find((remote) => remote.key === key);
    if (saved) {
      if (JSON.stringify(values) !== JSON.stringify(saved.after))
        throw new Error(
          `The remote ${key} changed. Remove its custody configuration before configuring it again.`,
        );
    } else if (values.some((value) => accepted.has(value))) {
      remotes.push({
        key,
        before: values,
        after: values.map((value) => (accepted.has(value) ? url : value)),
      });
    }
  }
  if (!remotes.length)
    throw new Error(
      "No remote URL matches this repository. Add its GitHub remote, then retry.",
    );
  // Save the receipt first so a partial Git write remains recoverable.
  writeHostFile(deps.paths.hostFile, {
    ...host,
    github_broker_enabled: true,
    github_repositories: [
      ...receipts.filter((entry) => entry !== previous),
      { cwd, repository, harness: options.harness, url, helper, remotes },
    ],
  });
  git(deps, cwd, ["config", "--local", "--replace-all", helperKey, ""]);
  git(deps, cwd, ["config", "--local", "--add", helperKey, helper]);
  git(deps, cwd, ["config", "--local", pathKey, "true"]);
  for (const remote of remotes)
    setGitValues(deps, cwd, remote.key, remote.after);
  deps.out(
    `GitHub requests for ${repository} now use this host's proxy. One live ${options.harness} session in this directory is required.`,
  );
}

export async function githubCredential(
  options: { harness: string; cwd: string; operation: string; input: string },
  rootDeps: CliDeps,
): Promise<void> {
  if (options.operation !== "get") return;
  const deps = depsForHarness(rootDeps, options.harness);
  const host = readHostFile(deps.paths.hostFile);
  if (!host) throw new Error("This host is not enrolled");
  const fields = Object.fromEntries(
    options.input
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  const match = /^github\/([A-Za-z0-9-]+\/[^/]+)\.git$/.exec(fields.path ?? "");
  if (
    fields.protocol !== "http" ||
    fields.host !== `127.0.0.1:${host.port}` ||
    !match
  )
    throw new Error("The GitHub helper only answers this host's proxy");
  // Recheck: a linked worktree may have been added after configuration.
  requireSingleWorktree(deps, resolve(options.cwd));
  const answer = await deps.daemonPost?.("/github-lease", {
    repository: match[1],
    cwd: resolve(options.cwd),
    harness: options.harness,
  });
  if (answer?.status !== 200)
    throw new Error(
      "The daemon refused a GitHub run credential. Check the live session and host status.",
    );
  const body = JSON.parse(answer.body) as { token?: unknown };
  if (
    typeof body.token !== "string" ||
    !/^oxgit_[A-Za-z0-9_-]+$/.test(body.token)
  )
    throw new Error("The daemon returned an invalid GitHub run credential");
  deps.out(`username=oxagen\npassword=${body.token}\n`);
}

export function readCredentialInput(): string {
  return readFileSync(0, "utf8");
}

/**
 * Whether `cwd` is gone or no longer a Git checkout. Only git's own "not a
 * git repository" counts: a git that cannot run, or refuses a checkout it
 * does not trust, says nothing about whether our settings are still in it.
 */
function checkoutGone(deps: CliDeps, cwd: string): boolean {
  if (!existsSync(cwd)) return true;
  const out = deps.exec("git", ["-C", cwd, "rev-parse", "--git-dir"]);
  return out.status !== 0 && /not a git repository/i.test(out.stderr);
}

/**
 * Remove recorded proxy settings before the daemon stops. Foreign helpers
 * survive. A receipt whose checkout was deleted is dropped with a warning:
 * its settings went with it, and refusing on it blocked every later
 * unenroll and enroll.
 */
export function restoreGithubRepositories(
  host: Pick<HostFile, "github_repositories"> | undefined,
  deps: CliDeps,
  warnings: string[] = [],
): string[] {
  const failures: string[] = [];
  for (const entry of host?.github_repositories ?? []) {
    if (checkoutGone(deps, entry.cwd)) {
      warnings.push(
        `${entry.cwd} is gone or is no longer a Git checkout, so its GitHub proxy settings went with it; its receipt was dropped`,
      );
      continue;
    }
    try {
      const helperKey = `credential.${entry.url}.helper`;
      const current = git(
        deps,
        entry.cwd,
        ["config", "--local", "--get-all", helperKey],
        true,
      );
      if (current && current !== entry.helper) {
        failures.push(
          `${entry.cwd}: the GitHub proxy helper changed. Remove its proxy settings before unenrolling.`,
        );
        continue;
      }
      let changed = false;
      for (const remote of entry.remotes) {
        const values = git(
          deps,
          entry.cwd,
          ["config", "--local", "--get-all", remote.key],
          true,
        ).split("\n");
        if (JSON.stringify(values) === JSON.stringify(remote.before)) continue;
        if (JSON.stringify(values) !== JSON.stringify(remote.after)) {
          failures.push(
            `${entry.cwd}: ${remote.key} changed. Restore its recorded remote URLs before unenrolling.`,
          );
          changed = true;
        }
      }
      if (changed) continue;
      for (const remote of entry.remotes)
        setGitValues(deps, entry.cwd, remote.key, remote.before);
      for (const key of [helperKey, `credential.${entry.url}.useHttpPath`])
        git(deps, entry.cwd, ["config", "--local", "--unset-all", key], true);
    } catch {
      failures.push(
        `${entry.cwd}: could not remove the GitHub proxy settings. Restore the directory or remove its settings before unenrolling.`,
      );
    }
  }
  return failures;
}
