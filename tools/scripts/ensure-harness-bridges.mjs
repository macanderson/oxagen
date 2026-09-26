#!/usr/bin/env node
/**
 * The two harness bridges point Codex and Cursor at the one copy of the
 * skills and commands under `.claude/`: `.agents/skills` (Codex) and
 * `.cursor/commands` (Cursor). Both are committed as symlinks. A Windows
 * checkout with `core.symlinks=false`, the default without Developer Mode,
 * writes each one as a text file holding its target, so Codex sees no skills
 * and Cursor sees no commands, and nothing says why (#3367).
 *
 *   node tools/scripts/ensure-harness-bridges.mjs          materialize
 *   node tools/scripts/ensure-harness-bridges.mjs --check  fail unless both resolve
 *
 * Materialize replaces a bridge Git wrote as a text file with a directory
 * junction on Windows and a symlink elsewhere, then marks it skip-worktree so
 * `git status` stays clean. A bridge that already resolves is left alone. It
 * runs from the root `prepare` script on every install, so it prints nothing
 * when there is nothing to do and never fails the install. `--check` fails
 * when a bridge resolves to anything but a directory, so the failure names
 * itself instead of looking like a repository with no skills (ADR-141).
 */
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Each bridge, by its path from the repository root. */
export const BRIDGES = [".agents/skills", ".cursor/commands"];

/**
 * The directory a bridge's link text names, as an absolute path, or null
 * when the text cannot be a link inside the repository. Git writes the text
 * with `/`, a hand-made file may use `\`, and a trailing separator or line
 * break is not part of the target.
 *
 * @param {string} root
 * @param {string} bridge
 * @param {string} text
 * @returns {string | null}
 */
export function bridgeTarget(root, bridge, text) {
  const link = text.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (link === "" || link.includes("\n") || link.includes("\0")) return null;
  if (isAbsolute(link) || /^[A-Za-z]:/.test(link)) return null;
  const target = resolve(root, dirname(bridge), ...link.split("/"));
  const inside = relative(resolve(root), target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside))
    return null;
  return target;
}

/**
 * What is on disk at a bridge.
 * - `resolves`: it leads to a directory (a symlink, a junction, or a real one).
 * - `text-file`: Git wrote the link as a file; `target` is where it points.
 * - `missing`: nothing is there.
 * - `broken`: anything else, such as a link to nowhere or a file that names
 *   no directory in the repository.
 *
 * @param {string} root
 * @param {string} bridge
 * @returns {{ state: "resolves" | "missing" | "broken" } | { state: "text-file", target: string }}
 */
export function inspectBridge(root, bridge) {
  const path = join(root, ...bridge.split("/"));
  let link;
  try {
    link = lstatSync(path);
  } catch {
    return { state: "missing" };
  }
  try {
    if (statSync(path).isDirectory()) return { state: "resolves" };
  } catch {
    return { state: "broken" };
  }
  if (!link.isFile() || link.size > 4096) return { state: "broken" };
  const target = bridgeTarget(root, bridge, readFileSync(path, "utf8"));
  if (target === null) return { state: "broken" };
  try {
    if (!statSync(target).isDirectory()) return { state: "broken" };
  } catch {
    return { state: "broken" };
  }
  return { state: "text-file", target };
}

/**
 * Replace a bridge Git wrote as a text file with a link to its target: a
 * junction on Windows, which needs neither Developer Mode nor an
 * administrator, and a relative symlink elsewhere, the form Git commits.
 *
 * @param {string} root
 * @param {string} bridge
 * @param {string} target
 * @param {NodeJS.Platform} platform
 */
export function materializeBridge(root, bridge, target, platform) {
  const path = join(root, ...bridge.split("/"));
  unlinkSync(path);
  if (platform === "win32") symlinkSync(target, path, "junction");
  else symlinkSync(relative(dirname(path), target), path, "dir");
}

/**
 * Walk every bridge: materialize the text files, or in `check` mode only
 * report. Returns one line per bridge that is not a directory afterward.
 *
 * @param {{ root?: string, platform?: NodeJS.Platform, check?: boolean, bridges?: string[], onChange?: (bridge: string) => void }} options
 * @returns {string[]}
 */
export function ensureBridges(options = {}) {
  const root = options.root ?? repoRoot;
  const platform = options.platform ?? process.platform;
  const problems = [];
  for (const bridge of options.bridges ?? BRIDGES) {
    const found = inspectBridge(root, bridge);
    if (found.state === "resolves") continue;
    if (found.state === "text-file" && options.check !== true) {
      materializeBridge(root, bridge, found.target, platform);
      options.onChange?.(bridge);
      if (inspectBridge(root, bridge).state === "resolves") continue;
    }
    problems.push(
      found.state === "text-file"
        ? `${bridge} is a text file naming ${relative(root, found.target).split(sep).join("/")}, not a link to it. Run \`node tools/scripts/ensure-harness-bridges.mjs\`.`
        : `${bridge} is ${found.state === "missing" ? "missing" : "not a link to a directory"}.`,
    );
  }
  return problems;
}

/**
 * Tell Git to leave a materialized bridge alone. With `core.symlinks=false`
 * Git compares the link text it committed with what is on disk, and a
 * junction is a directory, so every checkout would read as modified.
 *
 * @param {string} root
 * @param {string} bridge
 */
function skipWorktree(root, bridge) {
  try {
    execFileSync("git", ["update-index", "--skip-worktree", "--", bridge], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    // Not a Git checkout, or Git is not on PATH: nothing to keep clean.
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let problems = [];
  try {
    problems = ensureBridges({
      check,
      onChange: (bridge) => {
        skipWorktree(repoRoot, bridge);
        console.log(`ensure-harness-bridges: linked ${bridge}`);
      },
    });
  } catch (error) {
    problems = [
      `could not link the bridges: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (problems.length > 0) {
    for (const line of problems)
      console.error(`ensure-harness-bridges: ${line}`);
    // An install never fails on this. The check does.
    if (check) process.exit(1);
  } else if (check) {
    console.log(
      `ensure-harness-bridges: ${BRIDGES.join(" and ")} resolve to directories.`,
    );
  }
}
