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
import { toRequest, type PermissionBroker } from "../permissions.js";

const execFileAsync = promisify(execFile);

/** Directories never walked by `list` / `glob` / `grep` — noise and huge trees. */
const IGNORE_DIRS = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
];
const IGNORE_SET = new Set(IGNORE_DIRS);

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
  const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!dirents) return; // unreadable directory — skip
  for (const entry of dirents) {
    if (entry.isDirectory() && IGNORE_SET.has(entry.name)) continue;
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
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(cwd, p));

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

    async editFile(filePath, oldString, newString) {
      const target = abs(filePath);
      const content = await fs.readFile(target, "utf-8");
      const count = content.split(oldString).length - 1;
      if (count === 0) throw new Error(`String not found in ${filePath}`);
      if (count > 1)
        throw new Error(`String matches ${count} times in ${filePath} — must be unique`);
      await fs.writeFile(target, content.replace(oldString, newString), "utf-8");
    },

    async list(dirPath) {
      const dirents = await fs.readdir(abs(dirPath ?? "."), { withFileTypes: true });
      return dirents
        .filter((e) => !IGNORE_SET.has(e.name))
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
      try {
        const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          killSignal: "SIGTERM",
        });
        return { exitCode: 0, stdout, stderr, timedOut: false };
      } catch (e: unknown) {
        const err = e as {
          code?: number;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
          signal?: string;
        };
        const timedOut = err.killed === true || err.signal === "SIGTERM";
        return {
          exitCode: typeof err.code === "number" ? err.code : 1,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? "",
          timedOut,
        };
      }
    },

    async diff() {
      try {
        const { stdout } = await execFileAsync("git", ["diff", "HEAD"], {
          cwd,
          maxBuffer: 50 * 1024 * 1024,
        });
        return stdout;
      } catch {
        return ""; // not a git repo, or git missing — no diff available
      }
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
      const { allowed, reason } = await decide("write_file", { path: filePath });
      if (!allowed) throw new Error(`Permission denied: ${reason || "write_file blocked"}`);
      return workspace.writeFile(filePath, content);
    },

    async editFile(filePath, oldString, newString) {
      const { allowed, reason } = await decide("edit_file", { path: filePath });
      if (!allowed) throw new Error(`Permission denied: ${reason || "edit_file blocked"}`);
      return workspace.editFile(filePath, oldString, newString);
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
