/**
 * Local coding tools for the agent loop.
 *
 * These are the host-filesystem / shell primitives that Claude Code-style
 * agentic coding needs and that the Oxagen platform deliberately does NOT expose
 * (the platform only has a sandboxed `agent.code.execute`, not host-fs tools).
 * Each is an AI SDK `tool()` whose `execute` operates on the local working
 * directory and returns a string the model can read.
 *
 * Safety note (v1): tools execute without an interactive permission prompt. The
 * user invoked `oxagen` against their own repo, so this mirrors a developer
 * running commands. Per-tool approval gating is a planned enhancement (it maps
 * onto the same approval flow the platform already has for risky capabilities).
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, join, isAbsolute } from "node:path";
import { queryCodeGraph } from "./code-graph.js";

const execAsync = promisify(exec);

const MAX_OUTPUT = 30_000; // chars; keep tool output from blowing the context window
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
]);

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return (
    text.slice(0, MAX_OUTPUT) +
    `\n… [truncated ${text.length - MAX_OUTPUT} chars]`
  );
}

/** Resolve a user-supplied path against cwd; absolute paths are honored as-is. */
function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function globToRegExp(pattern: string): RegExp {
  // Minimal glob → regex: ** matches across dirs, * within a segment, ? one char.
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

async function* walk(
  dir: string,
  cwd: string,
): AsyncGenerator<{ abs: string; rel: string }> {
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDir && IGNORE_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    const rel = relative(cwd, abs);
    if (entry.isDir) {
      yield* walk(abs, cwd);
    } else {
      yield { abs, rel };
    }
  }
}

export function buildTools(
  cwd: string,
  opts: { readOnly?: boolean } = {},
): ToolSet {
  const tools: ToolSet = {
    read_file: tool({
      description:
        "Read a file from the working directory. Returns the file contents (optionally a line range).",
      inputSchema: z.object({
        path: z.string().describe("File path, relative to cwd or absolute."),
        offset: z
          .number()
          .int()
          .optional()
          .describe("1-based start line (optional)."),
        limit: z
          .number()
          .int()
          .optional()
          .describe("Max number of lines to return (optional)."),
      }),
      execute: async ({ path, offset, limit }) => {
        try {
          const text = await fs.readFile(resolvePath(cwd, path), "utf8");
          if (offset == null && limit == null) return clip(text);
          const lines = text.split("\n");
          const start = offset ? offset - 1 : 0;
          const end = limit ? start + limit : lines.length;
          return clip(lines.slice(start, end).join("\n"));
        } catch (err) {
          return `Error reading ${path}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    write_file: tool({
      description:
        "Write (create or overwrite) a file with the given content. Creates parent directories as needed.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      execute: async ({ path, content }) => {
        try {
          const abs = resolvePath(cwd, path);
          await fs.mkdir(resolve(abs, ".."), { recursive: true });
          await fs.writeFile(abs, content, "utf8");
          return `Wrote ${content.length} bytes to ${path}`;
        } catch (err) {
          return `Error writing ${path}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    edit_file: tool({
      description:
        "Replace an exact substring in a file. old_string must appear exactly once. Use for surgical edits.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string().describe("Exact text to replace (must be unique)."),
        new_string: z.string().describe("Replacement text."),
      }),
      execute: async ({ path, old_string, new_string }) => {
        try {
          const abs = resolvePath(cwd, path);
          const text = await fs.readFile(abs, "utf8");
          const count = text.split(old_string).length - 1;
          if (count === 0) return `Error: old_string not found in ${path}.`;
          if (count > 1)
            return `Error: old_string appears ${count} times in ${path}; make it unique.`;
          await fs.writeFile(abs, text.replace(old_string, new_string), "utf8");
          return `Edited ${path}`;
        } catch (err) {
          return `Error editing ${path}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    list_dir: tool({
      description: "List the entries of a directory (non-recursive).",
      inputSchema: z.object({
        path: z.string().optional().describe("Directory (default: cwd)."),
      }),
      execute: async ({ path }) => {
        try {
          const abs = resolvePath(cwd, path ?? ".");
          const dirents = await fs.readdir(abs, { withFileTypes: true });
          const lines = dirents
            .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
            .sort();
          return clip(lines.join("\n") || "(empty)");
        } catch (err) {
          return `Error listing ${path ?? "."}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    glob: tool({
      description:
        "Find files matching a glob pattern (e.g. 'src/**/*.ts'). Skips node_modules/.git/dist.",
      inputSchema: z.object({
        pattern: z.string(),
      }),
      execute: async ({ pattern }) => {
        const re = globToRegExp(pattern);
        const matches: string[] = [];
        for await (const { rel } of walk(cwd, cwd)) {
          if (re.test(rel)) matches.push(rel);
          if (matches.length >= 500) break;
        }
        return clip(matches.sort().join("\n") || "(no matches)");
      },
    }),

    grep: tool({
      description:
        "Search file contents with a regular expression. Returns matching file:line:text. Skips node_modules/.git/dist.",
      inputSchema: z.object({
        pattern: z.string().describe("JavaScript regular expression."),
        path: z
          .string()
          .optional()
          .describe("Subdirectory to search (default: cwd)."),
        glob: z
          .string()
          .optional()
          .describe("Restrict to files matching this glob (e.g. '*.ts')."),
      }),
      execute: async ({ pattern, path, glob }) => {
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch (err) {
          return `Invalid regex: ${err instanceof Error ? err.message : String(err)}`;
        }
        const fileRe = glob ? globToRegExp(glob.includes("/") ? glob : `**/${glob}`) : null;
        const root = resolvePath(cwd, path ?? ".");
        const hits: string[] = [];
        for await (const { abs, rel } of walk(root, cwd)) {
          if (fileRe && !fileRe.test(rel)) continue;
          let text: string;
          try {
            text = await fs.readFile(abs, "utf8");
          } catch {
            continue; // binary / unreadable
          }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i] as string)) {
              hits.push(`${rel}:${i + 1}:${(lines[i] as string).slice(0, 200)}`);
              if (hits.length >= 200) break;
            }
          }
          if (hits.length >= 200) break;
        }
        return clip(hits.join("\n") || "(no matches)");
      },
    }),

    code_graph: tool({
      description:
        "Query the repository's code graph — a precomputed index of symbols and " +
        "import relationships — for STRUCTURAL answers, instead of guessing paths " +
        "or grepping. Prefer this over `grep` for \"where is X defined\" and for " +
        "impact analysis before a change. Operations: 'search' finds where a " +
        "symbol (function/class/type/interface) is defined by name; 'file_symbols' " +
        "lists the top-level symbols a file defines; 'dependents' lists the files " +
        "that import a given file (what a change could break); 'imports' lists the " +
        "local files a given file imports.",
      inputSchema: z.object({
        operation: z.enum(["search", "file_symbols", "dependents", "imports"]),
        query: z
          .string()
          .describe(
            "A symbol name for 'search'; a file path (relative to cwd, or a suffix " +
              "like 'agent/loop.ts') for 'file_symbols' / 'dependents' / 'imports'.",
          ),
        limit: z
          .number()
          .int()
          .optional()
          .describe("Max results to return (default 25)."),
      }),
      execute: async ({ operation, query, limit }) => {
        try {
          return clip(await queryCodeGraph(cwd, operation, query, limit));
        } catch (err) {
          return `code_graph error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    bash: tool({
      description:
        "Run a shell command in the working directory. Use for builds, tests, git, package managers. Has a timeout.",
      inputSchema: z.object({
        command: z.string(),
        timeout_ms: z
          .number()
          .int()
          .optional()
          .describe("Timeout in milliseconds (default 120000, max 600000)."),
      }),
      execute: async ({ command, timeout_ms }) => {
        const timeout = Math.min(timeout_ms ?? 120_000, 600_000);
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            shell: "/bin/bash",
          });
          const out = [stdout, stderr].filter(Boolean).join("\n").trim();
          return clip(out || "(no output)");
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
          if (e.killed) return `Command timed out after ${timeout}ms.`;
          const out = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
          return clip(`Command failed:\n${out}`);
        }
      },
    }),
  };

  // Read-only mode: withhold every mutating tool so the model literally cannot
  // change the filesystem or run commands.
  if (opts.readOnly) {
    delete tools["write_file"];
    delete tools["edit_file"];
    delete tools["bash"];
  }
  return tools;
}
