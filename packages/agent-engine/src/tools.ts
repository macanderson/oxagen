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
import type { FileLockProvider } from "./ports";
import { delay } from "./loop-driver";
import { buildStructuredTools } from "./tools-structured";

const MAX_OUTPUT = 30_000; // chars; keep tool output from blowing the context window
// When truncating, keep this fraction of the budget as the HEAD; the rest is the
// TAIL. A failing test/build run puts its most actionable content — the failure
// summary, the assertion, the stack — at the very END, so head-only truncation
// (the old behavior) routinely discarded exactly what the model needed. Keeping
// both ends preserves the command/context (head) AND the verdict (tail).
const HEAD_FRACTION = 0.6;

/**
 * Clip over-long tool output to {@link MAX_OUTPUT} chars, MIDDLE-OUT: keep the
 * head and the tail, drop the middle. Exported for tests.
 */
export function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const dropped = text.length - MAX_OUTPUT;
  const headLen = Math.floor(MAX_OUTPUT * HEAD_FRACTION);
  const tailLen = MAX_OUTPUT - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  return `${head}\n… [${dropped} chars truncated from the middle — head + tail kept]\n${tail}`;
}

// ── read_file line numbering ─────────────────────────────────────────────────

/**
 * Prefix each line with its true 1-based file line number, `cat -n` style:
 * a right-aligned number, a tab, then the line text. `startLine` is the real
 * file line number of the FIRST line of `text`, so a range read (offset/limit)
 * reports true line numbers rather than 1..N. The number column is sized to the
 * largest number in the block so every number right-aligns.
 *
 * Shared by the engine `read_file` tool and the legacy CLI `read_file` tool so
 * the model sees identical, line-addressable output from either path. Pure.
 */
export function formatWithLineNumbers(text: string, startLine = 1): string {
  if (text === "") return "";
  const lines = text.split("\n");
  // A trailing newline yields an empty final segment; don't number it — `cat -n`
  // and editors count lines of content, not the empty tail after the last "\n".
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width)}\t${line}`)
    .join("\n");
}

// ── edit_file corrective feedback ────────────────────────────────────────────

/** Levenshtein edit distance between two strings (callers cap length first). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] as number) + 1,
        (curr[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] as number;
}

/** Similarity in [0,1] (1 = identical) over trimmed, length-capped strings. */
function similarity(a: string, b: string): number {
  const x = a.trim().slice(0, 200);
  const y = b.trim().slice(0, 200);
  const max = Math.max(x.length, y.length);
  if (max === 0) return 1; // both empty
  return 1 - levenshtein(x, y) / max;
}

/** The file line (1-based) most similar to `target`, or null for empty input. */
function closestLine(
  content: string,
  target: string,
): { line: number; text: string } | null {
  const lines = content.split("\n");
  let best: { line: number; text: string; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const score = similarity(lines[i] as string, target);
    if (!best || score > best.score) best = { line: i + 1, text: lines[i] as string, score };
  }
  return best ? { line: best.line, text: best.text } : null;
}

/** 1-based line numbers where `oldString` begins, up to `cap` occurrences. */
function occurrenceLines(content: string, oldString: string, cap: number): number[] {
  if (oldString === "") return [];
  const out: number[] = [];
  let from = 0;
  while (out.length < cap) {
    const idx = content.indexOf(oldString, from);
    if (idx === -1) break;
    let line = 1;
    for (let i = 0; i < idx; i++) if (content.charCodeAt(i) === 10) line++;
    out.push(line);
    from = idx + oldString.length;
  }
  return out;
}

/**
 * Corrective feedback for an `edit_file` miss so the model can self-correct
 * instead of blindly retrying. Returns `null` when `oldString` already appears
 * exactly once (no failure). Shared by every mutating Workspace impl and the
 * legacy CLI tool so the guidance is identical across paths. Pure.
 *
 *  - not found  → the closest line by fuzzy similarity + a whitespace hint.
 *  - ambiguous  → the first few matching line numbers + how to disambiguate.
 */
export function describeEditFailure(content: string, oldString: string): string | null {
  const count = oldString === "" ? 0 : content.split(oldString).length - 1;
  if (count === 1) return null;
  if (count === 0) {
    const near = closestLine(content, oldString.split("\n")[0] ?? "");
    const where = near
      ? `Closest match at line ${near.line}: ${near.text.slice(0, 200)}`
      : "No similar line found.";
    return (
      `old_string not found. ${where}\n` +
      `Check exact whitespace/indentation; read_file the region first.`
    );
  }
  const lines = occurrenceLines(content, oldString, 5);
  const more = count > lines.length ? ` (+${count - lines.length} more)` : "";
  return (
    `old_string appears ${count} times (lines ${lines.join(", ")}${more}); it must be unique. ` +
    `Add surrounding context to old_string, or pass replace_all:true to replace every occurrence.`
  );
}

// ── Test-file path detection (OXAGEN_FORBID_TEST_EDITS) ─────────────────────
// SWE-bench-style grading runs the SUT's own hidden, fixed test files — never
// whatever the agent leaves on disk. An agent that edits a test until it
// passes "succeeds" locally and self-certifies, then scores 0 for real: the
// edit is discarded before grading. When the env flag is set, buildWorkspaceTools
// denies every mutation under a test-shaped path so the model is structurally
// unable to go down that path, rather than merely asked not to.
//
// `isTestPath` lives in ./tools-shared so the structured tools (tools-structured/)
// can reuse it without a tools ↔ tools-structured import cycle; re-exported here
// so this module's public surface (and its existing importers) is unchanged.
export { isTestPath } from "./tools-shared";
import { isTestPath } from "./tools-shared";

/** Denial returned in place of a mutation when OXAGEN_FORBID_TEST_EDITS blocks it. */
export const TEST_EDIT_DENIED_MESSAGE =
  "Test files are read-only in this mode. Fix the SOURCE so the existing tests pass — " +
  "you cannot see or change the tests you're scored against.";

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

// ── Agent file locking (docs/specs/agent-file-locking/plan.md) ─────────────
// The SINGLE wiring point: write_file/edit_file acquire the graph-backed
// HOLDS_LOCK edge immediately before the real filesystem write and release it
// immediately after, for EVERY caller of runCodingAgent (chat, CLI,
// agent.repo.edit fleet dispatch) — there is exactly one enforcement point.

/** Acquire retry budget: a real hold is expected to be release-then-reacquire
 *  fast (this wiring releases right after each write), so a short bounded
 *  retry resolves almost every transient collision without the model having
 *  to react. */
const FILE_LOCK_ACQUIRE_ATTEMPTS = 3;
const FILE_LOCK_RETRY_DELAY_MS = 200;

/**
 * Acquire `path` (with a short bounded retry), run `execute`, and release the
 * lock afterward — success or failure. When `fileLock`/`lockContext` are not
 * supplied (the CLI's default: single-process, no shared Neo4j) this is a
 * transparent passthrough to `execute()`. On a denied acquire, returns a
 * clear denial string instead of performing the write — the calling agent
 * (chat or fleet) sees it as a tool result and can react (try another file,
 * wait, or tell the user), never a silently skipped write.
 */
async function withFileLock(
  path: string,
  action: "read" | "write",
  fileLock: FileLockProvider | null | undefined,
  lockContext: { agentId: string; executionId: string } | undefined,
  signal: AbortSignal | undefined,
  execute: () => Promise<string>,
): Promise<string> {
  if (!fileLock || !lockContext) return execute();

  let lockId: string | null = null;
  let heldBy: string | null = null;
  let blockedUntil: number | null = null;
  for (let attempt = 0; attempt < FILE_LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      try {
        await delay(FILE_LOCK_RETRY_DELAY_MS, signal);
      } catch {
        break; // aborted mid-retry — fall through to the denial path below
      }
    }
    let grant;
    try {
      grant = await fileLock.acquire({
        path,
        agentId: lockContext.agentId,
        executionId: lockContext.executionId,
        action,
      });
    } catch {
      // The port contract says acquire() never throws, but a misbehaving
      // adapter must not hang or crash the tool call — degrade to denial.
      grant = { granted: false, lockId: "", heldBy: null, blockedUntil: null };
    }
    if (grant.granted) {
      lockId = grant.lockId;
      break;
    }
    heldBy = grant.heldBy;
    blockedUntil = grant.blockedUntil;
  }

  if (lockId === null) {
    const until = blockedUntil ? new Date(blockedUntil).toISOString() : "shortly";
    return (
      `Blocked: ${path} is currently locked by another agent` +
      (heldBy ? ` (${heldBy})` : "") +
      ` until ${until}. Try a different file, or retry this edit shortly.`
    );
  }

  try {
    return await execute();
  } finally {
    try {
      await Promise.resolve(fileLock.release({ lockId, agentId: lockContext.agentId }));
    } catch {
      // Release is best-effort — the TTL (default 300s) and the turn-end
      // batch release-by-executionId backstop cover a failed release.
    }
  }
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
    /**
     * Turn abort signal, forwarded to `workspace.exec` so an aborted turn kills
     * the `bash` process subtree instead of leaving it running to its own
     * timeout. Undefined ⇒ bash is bounded only by its timeout (unchanged).
     */
    signal?: AbortSignal;
    /**
     * Graph-backed file lock (docs/specs/agent-file-locking/plan.md).
     * Undefined ⇒ write_file/edit_file proceed unlocked (the CLI's default —
     * single-process, no shared Neo4j session).
     */
    fileLock?: FileLockProvider | null;
    /** Identity `fileLock` acquires/releases under. Required when `fileLock` is supplied. */
    lockContext?: { agentId: string; executionId: string };
  } = {},
): ToolSet {
  const onEvent = opts.onEvent ?? (() => undefined);
  const signal = opts.signal;
  const fileLock = opts.fileLock;
  const lockContext = opts.lockContext;
  // Bench/CI-only gate (see OXAGEN_FORBID_TEST_EDITS in the config registry):
  // structurally denies mutations to test-shaped paths — see isTestPath above.
  const forbidTestEdits = process.env["OXAGEN_FORBID_TEST_EDITS"] === "1";

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
          const text = await workspace.readFile(path, { offset, limit });
          // Number lines cat -n style so the model can cite/target exact lines;
          // `offset` (1-based) is the true line number of the first line read.
          return clip(formatWithLineNumbers(text, offset ?? 1));
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
        if (forbidTestEdits && isTestPath(path)) return TEST_EDIT_DENIED_MESSAGE;
        return withFileLock(path, "write", fileLock, lockContext, signal, async () => {
          try {
            await workspace.writeFile(path, content);
            onEvent({ type: "file-edit", path, bytes: content.length });
            return `Wrote ${content.length} bytes to ${path}`;
          } catch (err) {
            return `Error writing ${path}: ${err instanceof Error ? err.message : String(err)}`;
          }
        });
      },
    }),

    edit_file: tool({
      description:
        "Replace an exact substring in a file. By default old_string must appear " +
        "exactly once; set replace_all:true to replace every occurrence. Use for " +
        "surgical edits.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string().describe("Exact text to replace."),
        new_string: z.string().describe("Replacement text."),
        replace_all: z
          .boolean()
          .optional()
          .describe(
            "Replace every occurrence instead of requiring a unique match (default false).",
          ),
      }),
      execute: async ({ path, old_string, new_string, replace_all }) => {
        if (forbidTestEdits && isTestPath(path)) return TEST_EDIT_DENIED_MESSAGE;
        return withFileLock(path, "write", fileLock, lockContext, signal, async () => {
          try {
            const count = await workspace.editFile(path, old_string, new_string, {
              replaceAll: replace_all,
            });
            onEvent({ type: "file-edit", path, bytes: new_string.length });
            return replace_all
              ? `Edited ${path} (${count} replacement${count === 1 ? "" : "s"})`
              : `Edited ${path}`;
          } catch (err) {
            return `Error editing ${path}: ${err instanceof Error ? err.message : String(err)}`;
          }
        });
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
        "local files a given file imports; 'semantic_search' finds files " +
        "conceptually related to a natural-language description (e.g. 'project " +
        "level configuration for the cli app') via embedding similarity, returning " +
        "a flat ranked FILE LIST — use it when 'search' returns nothing because the " +
        "query names no exact symbol or path. Anti-trigger: for a fuller domain map " +
        "(those files PLUS their symbols, call edges, and recent commits in one " +
        "bundle) prefer `code_map`, not this.",
      inputSchema: z.object({
        operation: z.enum([
          "search",
          "file_symbols",
          "dependents",
          "imports",
          "semantic_search",
        ]),
        query: z
          .string()
          .describe(
            "A symbol name for 'search'; a file path (relative to cwd, or a suffix " +
              "like 'agent/loop.ts') for 'file_symbols' / 'dependents' / 'imports'; " +
              "a natural-language concept for 'semantic_search'.",
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
        "Return a structured code-map BUNDLE for a conceptual or multi-word query: " +
        "semantically-matched source files PLUS their symbols (functions/classes/types), " +
        "inter-symbol call edges, and the recent commits that touched them — everything " +
        "needed to ORIENT in an unfamiliar domain in one call. Prefer this for questions " +
        "like 'everything related to payments', 'auth session handling', or 'where does " +
        "billing live'. Prefer it over `code_graph` semantic_search when you want that " +
        "fuller picture (symbols + call edges + history), not just a ranked list of files. " +
        "Anti-triggers: for a single symbol's definition or who-imports-what use " +
        "`code_graph` (search/file_symbols/dependents); for an exact string use `grep`. " +
        "Do NOT call it for a precise path you already know.",
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
        const result = await workspace.exec(command, { timeoutMs, signal });
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
