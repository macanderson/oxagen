/**
 * Workspace-bound coding tools for the agent loop.
 *
 * Identical tool names, descriptions, and inputSchemas as apps/cli/src/agent/tools.ts,
 * but execute bodies delegate to a `Workspace` abstraction instead of node:fs /
 * child_process — making them testable in-process (MemoryWorkspace) and portable
 * to sandboxed execution environments.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Workspace, CodeGraphProvider, CodeMapProvider, CodingEvent } from "./types";

const MAX_OUTPUT = 30_000; // chars; keep tool output from blowing the context window

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return (
    text.slice(0, MAX_OUTPUT) +
    `\n… [truncated ${text.length - MAX_OUTPUT} chars]`
  );
}

// ── Per-tool timeout backstop ────────────────────────────────────────────────
// Every tool must ALWAYS return: callers' turn-level inactivity guards treat an
// in-flight tool as legitimate progress precisely because a tool cannot hang
// forever. bash is bounded by the workspace's own exec timeout (this backstop
// sits a grace period above the declared/default value so the real timeout,
// with its better message, always fires first); everything else — fs walks,
// graph/code-map queries — gets the standard bound.

/** Standard bound for read/search/list/graph tools. */
const TOOL_TIMEOUT_MS = 60_000;
/** Default + max bash timeout — must mirror the bash tool's inputSchema. */
const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
/** Backstop margin above the tool's own timeout. */
const TOOL_TIMEOUT_GRACE_MS = 30_000;

/** Backstop deadline for one call, honoring bash's declared `timeout_ms`. */
export function toolBackstopMs(name: string, input: unknown): number {
  if (name === "bash") {
    const declared = (input as { timeout_ms?: unknown } | null)?.timeout_ms;
    const own = Math.min(
      typeof declared === "number" && Number.isFinite(declared)
        ? declared
        : BASH_DEFAULT_TIMEOUT_MS,
      BASH_MAX_TIMEOUT_MS,
    );
    return own + TOOL_TIMEOUT_GRACE_MS;
  }
  return TOOL_TIMEOUT_MS;
}

/**
 * Race a tool's execute against its backstop deadline. A timed-out tool
 * RESOLVES to a string result (never throws) so the turn stays alive and the
 * model can adapt. The underlying promise is left to settle in the background;
 * its eventual value is discarded.
 */
function withBackstop(
  name: string,
  input: unknown,
  run: () => PromiseLike<unknown>,
): Promise<unknown> {
  const ms = toolBackstopMs(name, input);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(
        `Tool ${name} timed out after ${Math.round(ms / 1000)}s (backstop) — ` +
          `it did not return. Try a narrower call${name === "bash" ? " or a larger timeout_ms" : ""}.`,
      );
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    Promise.resolve()
      .then(run)
      .then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err: unknown) => {
          clearTimeout(timer);
          resolve(`Error: ${err instanceof Error ? err.message : String(err)}`);
        },
      );
  });
}

/** Wrap every tool's execute in {@link withBackstop}. Returns a new ToolSet. */
function wrapToolsWithBackstop(tools: ToolSet): ToolSet {
  const out: ToolSet = {};
  for (const [name, toolDef] of Object.entries(tools)) {
    const exec = toolDef.execute;
    if (!exec) {
      out[name] = toolDef;
      continue;
    }
    out[name] = {
      ...toolDef,
      execute: (input: unknown, options: unknown) =>
        withBackstop(name, input, () =>
          Promise.resolve(
            (exec as (i: unknown, o: unknown) => unknown)(input, options),
          ),
        ),
    };
  }
  return out;
}

export function buildWorkspaceTools(
  workspace: Workspace,
  opts: {
    readOnly?: boolean;
    codeGraph?: CodeGraphProvider;
    codeMap?: CodeMapProvider;
    onEvent?: (e: CodingEvent) => void;
  } = {},
): ToolSet {
  const onEvent = opts.onEvent ?? (() => undefined);

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
          return clip(await workspace.readFile(path, { offset, limit }));
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
          await workspace.writeFile(path, content);
          onEvent({ type: "file-edit", path, bytes: content.length });
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
          await workspace.editFile(path, old_string, new_string);
          const bytes = new_string.length;
          onEvent({ type: "file-edit", path, bytes });
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
          const entries = await workspace.list(path);
          return clip(entries.join("\n") || "(empty)");
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
        try {
          const matches = await workspace.glob(pattern);
          return clip(matches.sort().join("\n") || "(no matches)");
        } catch (err) {
          return `Error globbing ${pattern}: ${err instanceof Error ? err.message : String(err)}`;
        }
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
        try {
          const hits = await workspace.grep(pattern, { path, glob });
          return clip(hits.join("\n") || "(no matches)");
        } catch (err) {
          return `Error grepping for ${pattern}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };

  // code_graph is optional — only added when a provider is supplied.
  if (opts.codeGraph) {
    const codeGraph = opts.codeGraph;
    tools.code_graph = tool({
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
          return clip(await codeGraph.query(operation, query, limit));
        } catch (err) {
          return `code_graph error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  }

  // code_map is optional — only added when a CodeMapProvider is injected.
  if (opts.codeMap) {
    const codeMapProvider = opts.codeMap;
    tools.code_map = tool({
      description:
        "Return a structured code-map bundle for a conceptual or multi-word query — " +
        "semantically matched source files, their symbols (functions/classes/types), " +
        "inter-symbol call edges, and recent commits that touched those files. " +
        "PREFER THIS OVER `grep` or `bash find` for questions like 'everything related " +
        "to payments', 'auth session handling', or 'where does billing live'. " +
        "Use `code_graph` for precise structural lookups ('where is X defined'); use " +
        "`code_map` for conceptual exploration across a domain.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Natural-language concept query, e.g. 'payments', 'auth session handling', " +
              "'everything related to billing'.",
          ),
        limit: z
          .number()
          .int()
          .optional()
          .describe("Max source files to return (default 20, max 50)."),
        domain: z
          .string()
          .optional()
          .describe(
            "Optional domain filter — only return nodes whose domain property matches " +
              "(e.g. 'billing', 'auth').",
          ),
        kinds: z
          .array(z.enum(["file", "symbol", "chunk", "commit"]))
          .optional()
          .describe("Which result kinds to include. Omit for all."),
      }),
      execute: async ({ query, limit, domain, kinds }) => {
        try {
          const bundle = await codeMapProvider.query(query, { limit, domain, kinds });
          // Format as a compact human-readable summary for the context window.
          const lines: string[] = [];
          lines.push(`Code map: "${query}" — ${bundle.files.length} file(s), ${bundle.symbols.length} symbol(s)`);
          if (bundle.files.length > 0) {
            lines.push("\nFiles:");
            for (const f of bundle.files) {
              const dom = f.domain ? ` [${f.domain}]` : "";
              lines.push(`  ${f.path}${dom}  score=${(f.score * 100).toFixed(0)}%`);
            }
          }
          if (bundle.symbols.length > 0) {
            lines.push("\nSymbols:");
            for (const s of bundle.symbols) {
              lines.push(`  ${s.kind} ${s.name}  (${s.path}:${s.startLine}-${s.endLine})`);
              if (s.signature) lines.push(`    ${s.signature}`);
            }
          }
          if (bundle.calls.length > 0) {
            lines.push("\nCall edges:");
            for (const c of bundle.calls) {
              lines.push(`  ${c.callerName} → ${c.calleeName}`);
            }
          }
          if (bundle.recentChanges.length > 0) {
            lines.push("\nRecent changes:");
            for (const ch of bundle.recentChanges) {
              lines.push(`  ${ch.commitSha.slice(0, 8)}  ${ch.committedAt.slice(0, 10)}  ${ch.authorName}  ${ch.message.split("\n")[0]?.slice(0, 72) ?? ""}`);
            }
          }
          return clip(lines.join("\n"));
        } catch (err) {
          return `code_map error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  }

  tools.bash = tool({
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
      const timeoutMs = Math.min(timeout_ms ?? 120_000, 600_000);
      try {
        const result = await workspace.exec(command, { timeoutMs });
        onEvent({ type: "command", command, exitCode: result.exitCode });
        if (result.timedOut) return `Command timed out after ${timeoutMs}ms.`;
        const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        if (result.exitCode !== 0) return clip(`Command failed:\n${out || "(no output)"}`);
        return clip(out || "(no output)");
      } catch (err) {
        return `Error running command: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // Read-only mode: withhold every mutating tool so the model literally cannot
  // change the filesystem or run commands.
  if (opts.readOnly) {
    delete tools["write_file"];
    delete tools["edit_file"];
    delete tools["bash"];
  }

  // Every tool gets the timeout backstop LAST so it bounds the whole execute
  // (including permission-broker wrapping applied by gated workspaces).
  return wrapToolsWithBackstop(tools);
}
