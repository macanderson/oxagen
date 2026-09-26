/**
 * Real git repositories for the collector's git tests.
 *
 * The reconciliation rule (ADR-188) depends on what `git log`, `git diff`,
 * and `git status` print after a pull, a rebase, and a squash merge, so the
 * tests that pin it run git against repositories made in a temporary
 * directory, never against a checkout. Each rig is a bare `origin`, the
 * checkout the session works in, and a second clone where someone else
 * commits and pushes.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecAsync } from "../host/service";

/** The email the session's checkout is configured with. */
export const ME = "agent@example.com";
/** The email of the person who pushes upstream. */
export const OTHER = "someone-else@example.com";

const scratch: string[] = [];

/** Remove every rig made since the last call. For `afterEach`. */
export function removeRigs(): void {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
}

/** Git with no global or system configuration, so the host's cannot leak in. */
function gitEnv(dir: string): NodeJS.ProcessEnv {
  const empty = join(dir, ".gitconfig-empty");
  writeFileSync(empty, "");
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export interface Rig {
  /** The directory that holds everything below. */
  root: string;
  /** The bare repository every clone pushes to. */
  origin: string;
  /** The checkout the session works in. */
  work: string;
  /** Another clone, where someone else commits and pushes. */
  upstream: string;
  git: (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => string;
  exec: ExecAsync;
  /** The environment every git call here runs in. */
  env: NodeJS.ProcessEnv;
}

export function rig(): Rig {
  // Real path, because git answers `--show-toplevel` with one and macOS
  // puts the temporary directory behind a symlink.
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "tacho-session-changes-")),
  );
  scratch.push(root);
  const env = gitEnv(root);
  const git = (cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
      { cwd, env: { ...env, ...extra }, encoding: "utf8" },
    );
  const exec: ExecAsync = (command, args) =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        { env, encoding: "utf8" },
        (error, stdout, stderr) => {
          const code = (error as (Error & { code?: unknown }) | null)?.code;
          resolve({
            status: error === null ? 0 : typeof code === "number" ? code : null,
            stdout,
            stderr,
          });
        },
      );
    });
  const origin = join(root, "origin.git");
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = join(root, "seed");
  git(root, ["clone", "-q", origin, seed]);
  identify(git, seed, ME);
  writeFileSync(join(seed, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(seed, "shared.txt"), "shared\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "seed"], datedNow());
  git(seed, ["push", "-q", "origin", "main"]);
  const work = join(root, "work");
  git(root, ["clone", "-q", origin, work]);
  identify(git, work, ME);
  const upstream = join(root, "upstream");
  git(root, ["clone", "-q", origin, upstream]);
  identify(git, upstream, OTHER);
  return { root, origin, work, upstream, git, exec, env };
}

export function identify(git: Rig["git"], cwd: string, email: string): void {
  git(cwd, ["config", "user.email", email]);
  git(cwd, ["config", "user.name", email.split("@")[0] ?? "someone"]);
}

/** A commit dated now, which a clock read before it counts from. */
export function datedNow(): NodeJS.ProcessEnv {
  const at = `@${Math.floor(Date.now() / 1000)} +0000`;
  return { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
}

/** Someone else commits two files upstream, changes `shared.txt`, and pushes. */
export function pushUpstream(r: Rig): void {
  r.git(r.upstream, ["pull", "-q", "--ff-only", "origin", "main"]);
  writeFileSync(join(r.upstream, "upstream-1.txt"), "theirs\n");
  writeFileSync(join(r.upstream, "upstream-2.txt"), "theirs too\n");
  writeFileSync(join(r.upstream, "shared.txt"), "shared\nupstream line\n");
  r.git(r.upstream, ["add", "."]);
  r.git(r.upstream, ["commit", "-q", "-m", "upstream work"], datedNow());
  r.git(r.upstream, ["push", "-q", "origin", "main"]);
}
