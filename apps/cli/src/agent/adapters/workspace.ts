/**
 * `CwdWorkspace` — the CLI's implementation of the engine `Workspace` port.
 *
 * Backs every engine filesystem/shell primitive with Node `fs` + `child_process`
 * rooted at a local directory, so `runCodingAgent` / `runTurn` operate directly
 * on the checked-out repository (ADR-019: the CLI is local + always-linked).
 *
 * Glob/grep are implemented in-process (a minimal `**`/`*`/`?` matcher plus a
 * recursive walk) rather than shelling out — this matches the rest of the CLI,
 * stays portable across BSD/GNU userlands, and avoids a redundant glob
 * dependency (the monorepo deliberately ships no glob library).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Workspace, CommandResult } from "@oxagen/agent-engine";
import { describeEditFailure } from "@oxagen/agent-engine";
import { toRequest, type PermissionBroker } from "../permissions.js";
import { runShellCommandBuffered } from "../../lib/shell-runner.js";
import { hasRipgrep, runRipgrep, parseRipgrepOutput } from "./ripgrep.js";

const execFileAsync = promisify(execFile);

/**
 * Directories never walked by `list` / `glob` / `grep` — build noise and huge
 * trees. Covers JS (node_modules, dist, …) and Python (.venv, __pycache__, …)
 * ecosystems so SWE-bench task repos don't drown grep/glob in generated files.
 */
const IGNORE_DIRS = [
  // JS / tooling
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
  // Python
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".eggs",
  ".ruff_cache",
  "__pypackages__",
];
const IGNORE_SET = new Set(IGNORE_DIRS);

/** Whether a directory name should be skipped when walking the tree. */
function isIgnoredDir(name: string): boolean {
  // `*.egg-info` dirs are per-package build metadata (name varies), so match by
  // suffix rather than listing them all.
  return IGNORE_SET.has(name) || name.endsWith(".egg-info");
}

/** Minimal glob → RegExp: `**` spans directories, `*` a segment, `?` one char. */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++; // consume the slash after **
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c as string)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Recursively yield every file under `dir`, skipping {@link IGNORE_DIRS}. */
async function* walk(
  dir: string,
  cwd: string,
): AsyncGenerator<{ abs: string; rel: string }> {
  const dirents = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => null);
  if (!dirents) return; // unreadable directory — skip
  for (const entry of dirents) {
    if (entry.isDirectory() && isIgnoredDir(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(abs, cwd);
    } else {
      yield { abs, rel: path.relative(cwd, abs) };
    }
  }
}

/** Build a {@link Workspace} rooted at `cwd`. */
export function createCwdWorkspace(cwd: string): Workspace {
  const abs = (p: string): string =>
    path.isAbsolute(p) ? p : path.resolve(cwd, p);

  return {
    root: cwd,

    async readFile(filePath, opts) {
      const content = await fs.readFile(abs(filePath), "utf-8");
      if (opts?.offset == null && opts?.limit == null) return content;
      // `offset` is 1-based (matches the engine's read_file tool + MemoryWorkspace).
      const lines = content.split("\n");
      const start = opts?.offset ? opts.offset - 1 : 0;
      const end = opts?.limit ? start + opts.limit : lines.length;
      return lines.slice(start, end).join("\n");
    },

    async writeFile(filePath, content) {
      const target = abs(filePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf-8");
    },

    async editFile(filePath, oldString, newString, opts) {
      const target = abs(filePath);
      const content = await fs.readFile(target, "utf-8");
      const count = oldString === "" ? 0 : content.split(oldString).length - 1;
      if (opts?.replaceAll) {
        if (count === 0)
          throw new Error(
            describeEditFailure(content, oldString) ??
              `String not found in ${filePath}`,
          );
        await fs.writeFile(
          target,
          content.split(oldString).join(newString),
          "utf-8",
        );
        return count;
      }
      // Structured feedback on a miss (closest line / ambiguous matches) so the
      // model can self-correct instead of blindly retrying the same string.
      if (count !== 1)
        throw new Error(
          describeEditFailure(content, oldString) ??
            `String not found in ${filePath}`,
        );
      await fs.writeFile(
        target,
        content.replace(oldString, newString),
        "utf-8",
      );
      return 1;
    },

    async list(dirPath) {
      const dirents = await fs.readdir(abs(dirPath ?? "."), {
        withFileTypes: true,
      });
      return dirents
        .filter((e) => !isIgnoredDir(e.name))
        .map((e) => e.name + (e.isDirectory() ? "/" : ""))
        .sort();
    },

    async glob(pattern) {
      const re = globToRegExp(pattern);
      const matches: string[] = [];
      for await (const { rel } of walk(cwd, cwd)) {
        if (re.test(rel)) matches.push(rel);
        if (matches.length >= 1000) break;
      }
      return matches.sort();
    },

    async grep(pattern, opts) {
      // Prefer ripgrep when available: far faster on large trees, .gitignore-aware,
      // and it skips binaries. Any real rg error (unsupported regex, spawn failure)
      // falls through to the in-process JS walk below, which also validates the
      // regex and enforces the Python-aware ignore set.
      if (await hasRipgrep()) {
        const args = [
          "--line-number",
          "--no-heading",
          "--color=never",
          ...(opts?.glob ? ["--glob", opts.glob] : []),
          "--",
          pattern,
          opts?.path ?? ".",
        ];
        const { ok, stdout } = await runRipgrep(args, cwd);
        if (ok) return parseRipgrepOutput(stdout, 500);
        // else fall through to the JS walk
      }

      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        throw new Error(
          `Invalid grep regex: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const fileRe = opts?.glob
        ? globToRegExp(opts.glob.includes("/") ? opts.glob : `**/${opts.glob}`)
        : null;
      const root = abs(opts?.path ?? ".");
      const hits: string[] = [];
      for await (const { abs: fileAbs, rel } of walk(root, cwd)) {
        if (fileRe && !fileRe.test(rel)) continue;
        let text: string;
        try {
          text = await fs.readFile(fileAbs, "utf-8");
        } catch {
          continue; // binary / unreadable
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i] as string)) {
            hits.push(`${rel}:${i + 1}:${(lines[i] as string).slice(0, 200)}`);
            if (hits.length >= 500) return hits;
          }
        }
      }
      return hits;
    },

    async exec(command, opts): Promise<CommandResult> {
      const timeoutMs = Math.min(opts?.timeoutMs ?? 120_000, 600_000);
      // Runs in its own process group so the timeout kills the whole subtree.
      // Node's `execFile({ timeout })` only signals the top-level `bash`, so a
      // grandchild that keeps the stdout pipe open (e.g. `npm run test | tail`)
      // would leave the streams open and hang this promise forever. The turn
      // signal is threaded through so an aborted turn kills the subtree too.
      return runShellCommandBuffered({
        command,
        cwd,
        timeoutMs,
        signal: opts?.signal,
      });
    },

    async diff() {
      // 1. Tracked changes vs HEAD (the original behavior). A rejection here
      //    means we're not in a git repo (or git is missing) — return "" exactly
      //    as before so callers keep their "no diff available" contract.
      let tracked: string;
      try {
        const { stdout } = await execFileAsync("git", ["diff", "HEAD"], {
          cwd,
          maxBuffer: 50 * 1024 * 1024,
        });
        tracked = stdout;
      } catch {
        return ""; // not a git repo, or git missing — no diff available
      }

      // 2. Untracked files never appear in `git diff HEAD`, yet a fix that
      //    CREATES a file must show up in the final patch (SWE-bench scores the
      //    whole diff, so an added file that's missing reads as an incomplete
      //    patch). Enumerate untracked paths without ever touching the index
      //    (no `git add`), then synthesize a create-file diff for each.
      let untracked: string[];
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["ls-files", "--others", "--exclude-standard"],
          { cwd, maxBuffer: 50 * 1024 * 1024 },
        );
        untracked = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
      } catch {
        return tracked; // couldn't enumerate untracked files — return what we have
      }

      let synthetic = "";
      for (const rel of untracked) {
        // Stat first: skip anything that isn't a regular file, and silently skip
        // files over 1 MiB (binary blobs / huge artifacts aren't patch content).
        let size: number;
        try {
          const info = await fs.stat(path.resolve(cwd, rel));
          if (!info.isFile()) continue;
          size = info.size;
        } catch {
          continue; // vanished between listing and stat — skip
        }
        if (size > 1024 * 1024) continue;

        // `git diff --no-index /dev/null <file>` emits a "new file" hunk. It
        // exits 1 whenever the two inputs differ (always true vs /dev/null),
        // which execFile surfaces as a rejection whose `stdout` holds the diff —
        // that is the SUCCESS path here, not an error. A real failure (code 2)
        // leaves stdout empty, so appending it is a harmless no-op.
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["diff", "--no-index", "--binary", "/dev/null", rel],
            { cwd, maxBuffer: 50 * 1024 * 1024 },
          );
          synthetic += stdout;
        } catch (err) {
          const out = (err as { stdout?: string }).stdout;
          if (typeof out === "string") synthetic += out;
        }
      }

      return tracked + synthetic;
    },
  };
}

/**
 * Wrap a {@link Workspace} so its mutating primitives (`writeFile`, `editFile`,
 * `exec`) are routed through the {@link PermissionBroker} before they run.
 *
 * This is how the converged CLI keeps its interactive approval / dangerous-command
 * / write-outside-workspace safety layer now that the engine's coding loop builds
 * its own tools (and so no longer sees the CLI's tool-gate). The broker maps each
 * call to the same `write_file` / `edit_file` / `bash` decision it always made, so
 * `/mode`, remembered rules, and the inline approval prompt behave identically.
 *
 * A denied file mutation throws (the engine surfaces it as a tool error); a denied
 * command returns a non-zero {@link CommandResult} so the model sees the refusal
 * and can adapt rather than crash. With no broker the workspace is returned as-is.
 */
export function createGatedWorkspace(
  workspace: Workspace,
  broker?: PermissionBroker,
): Workspace {
  if (!broker) return workspace;

  /** Resolve the broker's decision for one mutating call. */
  const decide = async (
    tool: "write_file" | "edit_file" | "bash",
    input: { path?: string; command?: string },
  ): Promise<{ allowed: boolean; reason: string }> => {
    const req = toRequest(tool, input, workspace.root);
    if (!req) return { allowed: true, reason: "" }; // not a gated tool
    const decision = await broker.check(req);
    return { allowed: decision.decision === "allow", reason: decision.reason };
  };

  return {
    ...workspace,

    async writeFile(filePath, content) {
      const { allowed, reason } = await decide("write_file", {
        path: filePath,
      });
      if (!allowed)
        throw new Error(`Permission denied: ${reason || "write_file blocked"}`);
      return workspace.writeFile(filePath, content);
    },

    async editFile(filePath, oldString, newString, opts) {
      const { allowed, reason } = await decide("edit_file", { path: filePath });
      if (!allowed)
        throw new Error(`Permission denied: ${reason || "edit_file blocked"}`);
      return workspace.editFile(filePath, oldString, newString, opts);
    },

    async exec(command, opts): Promise<CommandResult> {
      const { allowed, reason } = await decide("bash", { command });
      if (!allowed) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Permission denied: ${reason || "bash blocked"}`,
          timedOut: false,
        };
      }
      return workspace.exec(command, opts);
    },
  };
}
