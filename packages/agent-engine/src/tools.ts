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
import type { Workspace, CodingEvent, AskUserCallback } from "./types";
import type { FileLockProvider, DiagnosticsProvider } from "./ports";
import { delay } from "./internal/delay";
import { buildStructuredTools } from "./tools-structured";
import {
  EditIntegrityLedger,
  hashContent,
  checkSyntax,
  newSyntaxErrors,
} from "./edit-integrity";

const MAX_OUTPUT = 30_000; // chars; keep tool output from blowing the context window
// When truncating, keep this fraction of the budget as the HEAD; the rest is the
// TAIL. A failing test/build run puts its most actionable content — the failure
// summary, the assertion, the stack — at the very END, so head-only truncation
// (the old behavior) routinely discarded exactly what the model needed. Keeping
// both ends preserves the command/context (head) AND the verdict (tail).
const HEAD_FRACTION = 0.6;

/** What {@link clip} elided, handed to a marker builder for the middle note. */
export interface ClipInfo {
  /** Number of chars dropped from the middle. */
  dropped: number;
  /** The retained head slice (its last line is typically partial). */
  head: string;
  /** The retained tail slice (its first line is typically partial). */
  tail: string;
}

/** Generic middle-out note — used by every tool except an over-cap read_file. */
function defaultClipMarker({ dropped }: ClipInfo): string {
  return `… [${dropped} chars truncated from the middle — head + tail kept]`;
}

/**
 * Clip over-long tool output to {@link MAX_OUTPUT} chars, MIDDLE-OUT: keep the
 * head and the tail, drop the middle. `markerFor` builds the injected middle
 * note; it defaults to the generic char-count note. `read_file` overrides it
 * with a line-aware, recover-the-middle hint (see {@link readFileTruncationMarker}).
 * Exported for tests.
 */
export function clip(
  text: string,
  markerFor: (info: ClipInfo) => string = defaultClipMarker,
): string {
  if (text.length <= MAX_OUTPUT) return text;
  const dropped = text.length - MAX_OUTPUT;
  const headLen = Math.floor(MAX_OUTPUT * HEAD_FRACTION);
  const tailLen = MAX_OUTPUT - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  return `${head}\n${markerFor({ dropped, head, tail })}\n${tail}`;
}

/**
 * Clip over-long `text` to `max` chars, MIDDLE-OUT: keep the head
 * ({@link HEAD_FRACTION} of the budget by default) and the tail, drop the
 * middle, and splice in a marker naming the elided char count. The parameterized
 * sibling of {@link clip} (which is pinned to {@link MAX_OUTPUT} and takes a
 * custom marker): use this where the per-stream char budget varies — e.g. the
 * hosted sandbox-exec envelope caps stdout at 30k and stderr at 10k before the
 * result enters model context (packages/agent runtime/materialize-tools.ts). The
 * result is ~`max` chars plus the short marker. Pure. Exported for reuse + tests.
 */
export function clipMiddle(
  text: string,
  max: number,
  headFraction: number = HEAD_FRACTION,
): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  const headLen = Math.floor(max * headFraction);
  const tailLen = max - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  return `${head}\n… [${dropped} chars truncated from the middle — head + tail kept]\n${tail}`;
}

/**
 * Marker builder for an over-cap WHOLE-FILE `read_file`. Unlike the generic
 * middle-out note it tells the model exactly how to recover what was dropped:
 * the file's true line count, the (approximate) head/tail line spans kept, and
 * a concrete `offset`/`limit` to re-read the elided middle. `clip` cuts by
 * CHARS, so the boundary lines are partial and the head/tail line counts are
 * approximate — hence the "~" and the harmless slight overlap in the suggested
 * range. `totalLines` is the true line count of the full (pre-clip) content.
 */
export function readFileTruncationMarker(
  totalLines: number,
): (info: ClipInfo) => string {
  return ({ head, tail }: ClipInfo): string => {
    const headLines = head.split("\n").length;
    const tailLines = tail.split("\n").length;
    const middleLines = totalLines - headLines - tailLines;
    if (middleLines > 0) {
      return (
        `… [truncated: file has ${totalLines} lines total, showing ~first ${headLines} ` +
        `and last ${tailLines} lines — call read_file with offset:${headLines}, ` +
        `limit:${middleLines} to fetch the elided middle]`
      );
    }
    // Degenerate: one/few very long line(s). A line range can't address the
    // clipped span (it's within a single line), so keep a char-oriented note.
    return (
      `… [truncated: file has ${totalLines} line(s) but exceeds the ${MAX_OUTPUT}-char ` +
      `cap within a line — head + tail kept, middle chars elided]`
    );
  };
}

// ── Workspace-root path display (worktree divergence guard) ─────────────────
// File tools resolve RELATIVE paths against the workspace root captured at
// session start — never against wherever the last `bash` command `cd`-ed
// (each bash call is a fresh shell in the root; `cd` does not persist). When
// an agent works in a different checkout — e.g. a git worktree it created via
// bash — a relative-path write silently lands in the LAUNCH directory, and
// every bash verification in the worktree then reads back unchanged files:
// "my edits aren't being written to disk". Echoing the RESOLVED absolute path
// in every mutation result makes the divergence visible on the very first
// write, so the model can self-correct by switching to absolute paths.

/** Absolute display path for a mutation result: relative paths join `root`. */
export function resolveDisplayPath(root: string, p: string): string {
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return p; // already absolute
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return base === "" ? `/${p}` : `${base}/${p}`;
}

// ── read_file line numbering ─────────────────────────────────────────────────

/**
 * Prefix each line with its true 1-based file line number, `cat -n` style:
 * a right-aligned number, a tab, then the line text. `startLine` is the real
 * file line number of the FIRST line of `text`, so a range read (offset/limit)
 * reports true line numbers rather than 1..N. The number column is sized to the
 * largest number in the block so every number right-aligns.
 *
 * Shared by every `read_file` implementation so the model sees identical,
 * line-addressable output from any of them. Pure.
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

/** Chars of each string the similarity score looks at (bounds the DP grid). */
const SIMILARITY_WINDOW = 200;

/** Trim + cap a line to the window the similarity score is computed over. */
function similarityKey(s: string): string {
  return s.trim().slice(0, SIMILARITY_WINDOW);
}

/** Similarity in [0,1] (1 = identical) over trimmed, length-capped strings. */
function similarity(a: string, b: string): number {
  const x = similarityKey(a);
  const y = similarityKey(b);
  const max = Math.max(x.length, y.length);
  if (max === 0) return 1; // both empty
  return 1 - levenshtein(x, y) / max;
}

/**
 * The file line (1-based) most similar to `target`, or null for empty input.
 *
 * Every line runs a Levenshtein DP against `target`, which is O(200²) per line
 * once both are capped — so a naive sweep of a 10k-line file is ~4×10⁸ inner
 * steps of SYNCHRONOUS work on the caller's thread, and this runs on the
 * `edit_file` MISS path, driven by model-chosen input, inside a shared API
 * process. The per-tool backstop cannot interrupt a synchronous loop, so the
 * cost is contained here instead: `levenshtein(x, y) >= | |x| - |y| |`, hence
 * `similarity(x, y) <= 1 - ||x|-|y||/max`. When that ceiling cannot beat the
 * best score so far, the DP is skipped. The prune is exact — it only ever drops
 * candidates that could not have won under the strict `>` comparison — so the
 * chosen line is identical to the unpruned sweep.
 */
function closestLine(
  content: string,
  target: string,
): { line: number; text: string } | null {
  const lines = content.split("\n");
  const y = similarityKey(target);
  let best: { line: number; text: string; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] as string;
    if (best) {
      const x = similarityKey(text);
      const max = Math.max(x.length, y.length);
      const ceiling = max === 0 ? 1 : 1 - Math.abs(x.length - y.length) / max;
      if (ceiling <= best.score) continue;
    }
    const score = similarity(text, target);
    if (!best || score > best.score) best = { line: i + 1, text, score };
  }
  return best ? { line: best.line, text: best.text } : null;
}

/** 1-based line numbers where `oldString` begins, up to `cap` occurrences. */
function occurrenceLines(
  content: string,
  oldString: string,
  cap: number,
): number[] {
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
 * exactly once (no failure). Shared by every mutating Workspace implementation
 * so the guidance is identical across all of them. Pure.
 *
 *  - not found  → the closest line by fuzzy similarity + a whitespace hint.
 *  - ambiguous  → the first few matching line numbers + how to disambiguate.
 */
export function describeEditFailure(
  content: string,
  oldString: string,
): string | null {
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
/**
 * `ask_user` legitimately blocks on a HUMAN, so the 60s read/search bound would
 * cut off someone still deciding. Its real bound is the person (or a turn abort,
 * which the REPL overlay resolves by dismissing) — this generous ceiling is only
 * a safety net for a caller whose callback never resolves.
 */
const ASK_USER_BACKSTOP_MS = 30 * 60_000;

/** Backstop deadline for one call, honoring bash's declared `timeout_secs`. */
export function toolBackstopMs(name: string, input: unknown): number {
  if (name === "bash") {
    const declared = (input as { timeout_secs?: unknown } | null)?.timeout_secs;
    const own = Math.min(
      typeof declared === "number" && Number.isFinite(declared)
        ? declared * 1000
        : BASH_DEFAULT_TIMEOUT_MS,
      BASH_MAX_TIMEOUT_MS,
    );
    return own + TOOL_TIMEOUT_GRACE_MS;
  }
  if (name === "ask_user") return ASK_USER_BACKSTOP_MS;
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
          `it did not return. Try a narrower call${name === "bash" ? " or a larger timeout_secs" : ""}.`,
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
// The SINGLE wiring point: write_file/edit_file acquire the transactional
// Postgres lease immediately before the real filesystem write and release it
// immediately after, for EVERY surface that runs a turn (chat, CLI,
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
 * supplied (the CLI's default: single-process) this is a
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
    const until = blockedUntil
      ? new Date(blockedUntil).toISOString()
      : "shortly";
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
      await Promise.resolve(
        fileLock.release({ lockId, agentId: lockContext.agentId }),
      );
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
    /**
     * Optional project-diagnostics provider (tsserver / LSP). When supplied, the
     * edit-integrity gate unions its before/after output with the built-in
     * single-file syntax check on every edit_file/write_file. Undefined ⇒ only
     * the built-in syntactic check gates (the CLI's default). A provider failure
     * degrades to the built-in check alone. See {@link DiagnosticsProvider}.
     */
    diagnostics?: DiagnosticsProvider;
    /**
     * Interactive clarification callback. When supplied, the `ask_user` tool is
     * registered; when omitted — every headless / one-shot surface with nobody
     * to ask — the tool is never advertised.
     */
    askUser?: AskUserCallback;
  } = {},
): ToolSet {
  const onEvent = opts.onEvent ?? (() => undefined);
  const signal = opts.signal;
  const fileLock = opts.fileLock;
  const lockContext = opts.lockContext;
  const diagnostics = opts.diagnostics;
  // Bench/CI-only gate (see OXAGEN_FORBID_TEST_EDITS in the config registry):
  // structurally denies mutations to test-shaped paths — see isTestPath above.
  const forbidTestEdits = process.env["OXAGEN_FORBID_TEST_EDITS"] === "1";

  // Edit integrity (docs/specs/unpoisonable-edits): ONE ledger per
  // buildWorkspaceTools call — i.e. per agent run. A whole-file read pins the
  // content-hash anchor; edit_file/write_file verify it before writing (stale
  // anchor ⇒ refuse the clobber) and re-pin the new hash after. Always on — the
  // gate is structural, never opt-in.
  const ledger = new EditIntegrityLedger(workspace.root);

  /**
   * The NEW syntax/diagnostic errors an edit would introduce on `path`:
   * before/after delta of the built-in single-file syntax check, unioned with
   * the optional project-diagnostics provider. `beforeContent === null` marks a
   * CREATE (no prior content ⇒ no before-errors). A diagnostics-provider failure
   * degrades to the built-in check alone so a broken server never wedges an edit.
   */
  async function gateNewErrors(
    path: string,
    beforeContent: string | null,
    afterContent: string,
  ): Promise<string[]> {
    const beforeErrors =
      beforeContent === null ? [] : checkSyntax(path, beforeContent).errors;
    const afterErrors = checkSyntax(path, afterContent).errors;
    if (diagnostics) {
      try {
        const after = await diagnostics.diagnostics(path, afterContent);
        afterErrors.push(...after.errors);
        if (beforeContent !== null) {
          const before = await diagnostics.diagnostics(path, beforeContent);
          beforeErrors.push(...before.errors);
        }
      } catch {
        // Fail-open on the optional provider — the built-in syntax check stands.
      }
    }
    return newSyntaxErrors(beforeErrors, afterErrors);
  }

  /** The corrective note appended to a syntax-gate rejection. */
  const editRejection = (
    count: number,
    shown: string,
    errors: string[],
  ): string =>
    `Edit rejected (would introduce ${count} new syntax error${count === 1 ? "" : "s"} in ${shown}):\n` +
    `${errors.join("\n")}\n` +
    `Fix the edit, or pass expect_errors:true only if this is an intentional mid-refactor breakage.`;

  /** Shared stale-anchor rejection message (edit_file and write_file). */
  const staleAnchor = (shown: string, known: string, actual: string): string =>
    `Stale anchor: ${shown} changed on disk since you last read it ` +
    `(expected ${known}, found ${actual}). Re-read the file and re-apply your ` +
    `edit against the current content.`;

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
          const isRangeRead = offset !== undefined || limit !== undefined;
          // Edit integrity: a WHOLE-file read pins the content-hash anchor on the
          // RAW text (before line-numbering / clipping) so the next edit/write can
          // detect an external change. A ranged read never touches the ledger — it
          // saw only a slice, so it cannot vouch for the whole file's hash.
          if (!isRangeRead) ledger.record(path, hashContent(text));
          // Number lines cat -n style so the model can cite/target exact lines;
          // `offset` (1-based) is the true line number of the first line read.
          const formatted = formatWithLineNumbers(text, offset ?? 1);
          // A whole-file read (no offset/limit) that overflows the cap gets an
          // actionable, line-aware truncation note so the model re-reads the
          // elided middle via offset/limit instead of guessing. A ranged read
          // already targeted a span, so it keeps the generic middle-out marker.
          if (!isRangeRead && formatted.length > MAX_OUTPUT) {
            const totalLines = formatted.split("\n").length;
            return clip(formatted, readFileTruncationMarker(totalLines));
          }
          return clip(formatted);
        } catch (err) {
          return `Error reading ${path}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    write_file: tool({
      description:
        "Write (create or overwrite) a file with the given content. Creates parent directories as needed. " +
        "Relative paths resolve against the session workspace root — NOT the cwd of any prior `bash` " +
        "command — so pass absolute paths when working outside it (e.g. in a git worktree).",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
        expect_errors: z
          .boolean()
          .optional()
          .describe(
            "Declare that this edit intentionally introduces syntax/type errors " +
              "that a later step will fix; the declaration is recorded to the audit trail.",
          ),
      }),
      execute: async ({ path, content, expect_errors }) => {
        if (forbidTestEdits && isTestPath(path))
          return TEST_EDIT_DENIED_MESSAGE;
        return withFileLock(
          path,
          "write",
          fileLock,
          lockContext,
          signal,
          async () => {
            const shown = resolveDisplayPath(workspace.root, path);
            // Probe the FULL existing file (under the same lock) for existence,
            // the before-hash, and before-syntax — a create has none of these.
            let existed = true;
            let before: string | null = null;
            try {
              before = await workspace.readFile(path);
            } catch {
              existed = false;
              before = null;
            }
            // Stale-anchor guard: a file this run has read/written carries a
            // ledger hash; if it no longer matches the current on-disk content an
            // external change landed — refuse the blind clobber. A never-read file
            // has no entry (writes freely); a brand-new file trivially passes.
            if (existed && before !== null) {
              const currentHash = hashContent(before);
              const known = ledger.get(path);
              if (known !== undefined && known !== currentHash) {
                return staleAnchor(shown, known, currentHash);
              }
            }
            // Syntax gate on the NEW content (create ⇒ before = []).
            const fresh = await gateNewErrors(
              path,
              existed ? before : null,
              content,
            );
            if (fresh.length > 0 && !expect_errors) {
              return editRejection(fresh.length, shown, fresh);
            }
            const beforeHash =
              existed && before !== null ? hashContent(before) : undefined;
            const afterHash = hashContent(content);
            try {
              await workspace.writeFile(path, content);
            } catch (err) {
              return `Error writing ${path}: ${err instanceof Error ? err.message : String(err)}`;
            }
            ledger.record(path, afterHash);
            const declaredBreaking = fresh.length > 0 && !!expect_errors;
            onEvent({
              type: "file-edit",
              path,
              bytes: content.length,
              kind: existed ? "update" : "create",
              ...(beforeHash ? { beforeHash } : {}),
              afterHash,
              newDiagnostics: declaredBreaking ? fresh.length : 0,
              ...(declaredBreaking ? { declaredBreaking: true } : {}),
            });
            let result = `Wrote ${content.length} bytes to ${shown}`;
            if (beforeHash) result += ` [anchor ${beforeHash} → ${afterHash}]`;
            if (declaredBreaking)
              result += `\n— DECLARED BREAKING: ${fresh.length} new syntax error${fresh.length === 1 ? "" : "s"} recorded`;
            return result;
          },
        );
      },
    }),

    edit_file: tool({
      description:
        "Replace an exact substring in a file. By default old_string must appear " +
        "exactly once; set replace_all:true to replace every occurrence. Use for " +
        "surgical edits. Relative paths resolve against the session workspace root — " +
        "NOT the cwd of any prior `bash` command — so pass absolute paths when " +
        "working outside it (e.g. in a git worktree).",
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
        expect_errors: z
          .boolean()
          .optional()
          .describe(
            "Declare that this edit intentionally introduces syntax/type errors " +
              "that a later step will fix; the declaration is recorded to the audit trail.",
          ),
      }),
      execute: async ({
        path,
        old_string,
        new_string,
        replace_all,
        expect_errors,
      }) => {
        if (forbidTestEdits && isTestPath(path))
          return TEST_EDIT_DENIED_MESSAGE;
        return withFileLock(
          path,
          "write",
          fileLock,
          lockContext,
          signal,
          async () => {
            const shown = resolveDisplayPath(workspace.root, path);
            // 1. Read the current content (full) — the edit anchor's baseline.
            let current: string;
            try {
              current = await workspace.readFile(path);
            } catch (err) {
              return `Error editing ${path}: ${err instanceof Error ? err.message : String(err)}`;
            }
            // 2. Stale-anchor check: if this file was read/written this run but no
            //    longer hashes to the recorded anchor, another writer changed it —
            //    refuse rather than clobber, and tell the model to re-read.
            const currentHash = hashContent(current);
            const known = ledger.get(path);
            if (known !== undefined && known !== currentHash) {
              return staleAnchor(shown, known, currentHash);
            }
            // 3. Apply the replacement in memory. Reuse the corrective-feedback
            //    contract so guidance is unchanged: the default mode requires a
            //    UNIQUE match (describeEditFailure covers not-found + ambiguous),
            //    while replace_all only rejects a not-found (0-occurrence) miss.
            const occurrences =
              old_string === "" ? 0 : current.split(old_string).length - 1;
            let count: number;
            let newContent: string;
            if (replace_all) {
              if (occurrences === 0) {
                return `Error editing ${path}: ${describeEditFailure(current, old_string) ?? `old_string not found in ${path}`}`;
              }
              count = occurrences;
              newContent = current.split(old_string).join(new_string);
            } else {
              const failure = describeEditFailure(current, old_string);
              if (failure !== null) return `Error editing ${path}: ${failure}`;
              // describeEditFailure returned null ⇒ exactly one occurrence.
              count = 1;
              newContent = current.replace(old_string, new_string);
            }
            // 4. Syntax gate: only NEW damage blocks (before/after delta), and
            //    only when the model did not declare intentional breakage.
            const fresh = await gateNewErrors(path, current, newContent);
            if (fresh.length > 0 && !expect_errors) {
              return editRejection(fresh.length, shown, fresh);
            }
            // 5. Write and re-pin the anchor to the new content.
            const afterHash = hashContent(newContent);
            try {
              await workspace.writeFile(path, newContent);
            } catch (err) {
              return `Error editing ${path}: ${err instanceof Error ? err.message : String(err)}`;
            }
            ledger.record(path, afterHash);
            // 6. Emit the enriched event and return the anchored result.
            const declaredBreaking = fresh.length > 0 && !!expect_errors;
            onEvent({
              type: "file-edit",
              path,
              bytes: new_string.length,
              kind: "update",
              beforeHash: currentHash,
              afterHash,
              replacements: count,
              newDiagnostics: declaredBreaking ? fresh.length : 0,
              ...(declaredBreaking ? { declaredBreaking: true } : {}),
            });
            let result = `Edited ${shown} (${count} replacement${count === 1 ? "" : "s"}) [anchor ${currentHash} → ${afterHash}]`;
            if (declaredBreaking)
              result += `\n— DECLARED BREAKING: ${fresh.length} new syntax error${fresh.length === 1 ? "" : "s"} recorded`;
            return result;
          },
        );
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

    search: tool({
      description:
        "Search the workspace with one query: file contents (as a regular " +
        "expression when the query parses as one, literally otherwise) AND " +
        "file names. Returns name matches, then file:line:text content " +
        "matches. Skips node_modules/.git/dist.",
      inputSchema: z.object({
        query: z.string().min(1).describe("What to find."),
      }),
      execute: async ({ query }) => {
        // Stella's catalog retired `grep` and `glob` in favour of ONE search
        // and reserves both names, so a merged tool surface cannot carry them
        // (crates/stella-tools/src/custom.rs's name reservation). One query
        // over both axes also matches how models actually search: they rarely
        // know in advance whether the thing they remember is a path or a
        // symbol.
        const pattern = (() => {
          try {
            // Probe only: workspace.grep compiles the pattern itself.
            new RegExp(query);
            return query;
          } catch {
            return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          }
        })();
        try {
          const [contentHits, names] = await Promise.all([
            workspace.grep(pattern).catch(() => [] as string[]),
            workspace.glob("**/*").catch(() => [] as string[]),
          ]);
          const needle = query.toLowerCase();
          const nameHits = names
            .filter((name) => name.toLowerCase().includes(needle))
            .sort();
          const sections: string[] = [];
          if (nameHits.length > 0) {
            sections.push(`Files matching by name:\n${nameHits.join("\n")}`);
          }
          if (contentHits.length > 0) {
            sections.push(`Content matches:\n${contentHits.join("\n")}`);
          }
          return clip(sections.join("\n\n") || "(no matches)");
        } catch (err) {
          return `Error searching for ${query}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };

  // delete_file is gated on the workspace implementing deletion — the same
  // presence-not-flag gating ask_user uses. A workspace without it leaves the
  // model with `bash rm`, which records no file-touch event.
  if (workspace.deleteFile) {
    const deleteFile = workspace.deleteFile.bind(workspace);
    tools.delete_file = tool({
      description:
        "Delete a file. Use this, not `rm` in bash, so the deletion is " +
        "recorded like any other file change.",
      inputSchema: z.object({
        path: z.string(),
        reason: z
          .string()
          .optional()
          .describe("Why this file is being deleted (recorded, not shown)."),
      }),
      execute: async ({ path }) => {
        // Same gate as write_file/edit_file: deleting the grading test is the
        // same self-certification move as editing it, and a guard that stops
        // one but not the other stops neither.
        if (forbidTestEdits && isTestPath(path))
          return TEST_EDIT_DENIED_MESSAGE;
        try {
          await deleteFile(path);
          onEvent({
            type: "command",
            command: `delete_file ${path}`,
            exitCode: 0,
          });
          return `Deleted ${path}`;
        } catch (err) {
          return `Error deleting ${path}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  }

  // ask_user is optional — only added when an interactive surface supplies a
  // human-in-the-loop callback. A headless / one-shot run has nobody to answer,
  // so it never gets the tool and the model cannot call one that would block the
  // loop forever.
  if (opts.askUser) {
    const askUser = opts.askUser;
    tools.ask_user = tool({
      description:
        "Ask the human ONE structured clarification question — use it only when " +
        "the requirements are genuinely ambiguous AND guessing wrong is costly " +
        "(an irreversible or wide-blast-radius choice, or a fork the user clearly " +
        "cares about). Provide 2-5 short, concrete, mutually-exclusive options; " +
        "the user can always type their own answer instead. Do NOT use it for a " +
        "choice with an obvious convention or a safe default, and never ask more " +
        "than twice in one task. Returns the user's answer as plain text.",
      inputSchema: z.object({
        question: z
          .string()
          .describe("The single question to ask — one concrete sentence."),
        options: z
          .array(z.string())
          .describe("2-5 short, distinct candidate answers to offer."),
      }),
      execute: async ({ question, options }) => {
        const q = question.trim();
        if (q === "")
          return "ask_user error: question must not be empty. Re-ask with a concrete question.";
        // De-dupe (case-insensitively) and drop blanks, preserving order, then
        // validate the DISTINCT count — the requirement is 2-5 distinct options.
        const cleaned: string[] = [];
        const seen = new Set<string>();
        for (const raw of options) {
          const t = raw.trim();
          if (t === "") continue;
          const key = t.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          cleaned.push(t);
        }
        if (cleaned.length < 2 || cleaned.length > 5)
          return (
            `ask_user error: provide between 2 and 5 distinct, non-empty options ` +
            `(got ${cleaned.length}). Re-ask with 2-5 concrete choices, or just ` +
            `proceed with your best judgment and state the assumption.`
          );
        // Respect a turn already aborted before we surface the prompt — don't
        // pop a question the user can no longer answer.
        if (signal?.aborted)
          return "ask_user: the turn was aborted before the user answered — proceed with your best judgment and state the assumption.";
        try {
          const { answer, wasFreeText } = await askUser({
            question: q,
            options: cleaned,
          });
          return `${wasFreeText ? "[user wrote]" : "[user chose]"} ${answer}`;
        } catch (err) {
          return `ask_user error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  }

  tools.bash = tool({
    description:
      "Run a shell command in the working directory. Use for builds, tests, git, package managers. Has a timeout.",
    inputSchema: z.object({
      command: z.string(),
      timeout_secs: z
        .number()
        .int()
        .optional()
        .describe("Timeout in seconds (default 120, max 600)."),
    }),
    execute: async ({ command, timeout_secs }) => {
      const timeoutMs = Math.min(timeout_secs ?? 120, 600) * 1000;
      try {
        const result = await workspace.exec(command, { timeoutMs, signal });
        onEvent({ type: "command", command, exitCode: result.exitCode });
        if (result.timedOut) return `Command timed out after ${timeoutMs}ms.`;
        const out = [result.stdout, result.stderr]
          .filter(Boolean)
          .join("\n")
          .trim();
        if (result.exitCode !== 0)
          return clip(`Command failed:\n${out || "(no output)"}`);
        return clip(out || "(no output)");
      } catch (err) {
        return `Error running command: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // Deterministic structured tools (ADR-021 §3) — test_unit_run, build_package_run,
  // git_diff_summarize, workspace_health_check. They run tests/typecheck/diff/status
  // and return typed, bounded output instead of the model parsing raw `bash`
  // scrollback. They never mutate the filesystem, so they are advertised in BOTH
  // read-write and read-only modes (unlike write_file/edit_file/bash below).
  Object.assign(tools, buildStructuredTools(workspace, { signal, onEvent }));

  // Read-only mode: withhold every mutating tool so the model literally cannot
  // change the filesystem or run arbitrary commands. The structured tools above
  // stay — they only run fixed read-only diagnostics (no file writes).
  if (opts.readOnly) {
    delete tools["write_file"];
    delete tools["edit_file"];
    delete tools["bash"];
    delete tools["delete_file"];
  }

  // Every tool gets the timeout backstop LAST so it bounds the whole execute
  // (including permission-broker wrapping applied by gated workspaces).
  return wrapToolsWithBackstop(tools);
}
