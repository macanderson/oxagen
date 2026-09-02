// tools-structured/parse.ts
//
// Pure, deterministic parsers behind the structured tools (ADR-021 §3: raw tool
// output — vitest logs, tsc errors, git diffs, porcelain status — never reaches
// the model; a function truncates/parses/ranks it into a small typed shape
// first). ZERO model calls anywhere in this module (ADR-021 §1: parsing and
// selection are pure functions — the lowest rung — so no model is involved).
//
// Every function here is side-effect-free and exported so the tools' unit tests
// exercise them directly against fixture strings.

import { isTestPath } from "../tools-shared";

// ── Output caps (bound the model payload) ────────────────────────────────────

/** Max failing tests reported by test_run_unit. */
export const MAX_TEST_FAILURES = 20;
/** Max chars of a single failure reason. */
export const MAX_REASON_CHARS = 500;
/** Max compiler errors reported by build_execute. */
export const MAX_BUILD_ERRORS = 30;
/** Max files reported by git_diff_summarize. */
export const MAX_DIFF_FILES = 50;
/** Max enclosing symbols reported per changed file. */
export const MAX_SYMBOLS_PER_FILE = 12;
/** Max test files test_run_unit will select+run from changedFiles. */
export const MAX_SELECTED_TESTS = 60;
/** Max tail chars kept from raw stderr on a reporter-parse failure. */
export const MAX_STDERR_TAIL = 2_000;

// ── Generic helpers ──────────────────────────────────────────────────────────

/** Clip a string to `max` chars, marking the drop. */
export function clipStr(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} chars truncated]`;
}

/**
 * Extract the first complete top-level JSON object from `raw` (a reporter may
 * print log lines before/after the JSON). Returns the parsed value or null.
 * Deterministic brace-balanced scan; ignores braces inside strings.
 */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  // Fast path: the whole payload is the JSON object.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to brace scan */
  }
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** POSIX single-quote a shell argument. */
export function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// ── test_run_unit: vitest JSON reporter (jest-compatible) ────────────────────

export interface TestFailure {
  test: string;
  file: string | null;
  line: number | null;
  reason: string;
}

export interface VitestParseResult {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
  failures: TestFailure[];
  truncatedFailures: boolean;
  /** Set when the JSON reporter output could not be parsed. */
  parseError?: boolean;
}

interface JsonAssertion {
  title?: string;
  fullName?: string;
  status?: string;
  failureMessages?: string[];
  duration?: number;
  location?: { line?: number; column?: number } | null;
}
interface JsonFile {
  name?: string;
  status?: string;
  assertionResults?: JsonAssertion[];
  startTime?: number;
  endTime?: number;
}
interface VitestJson {
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  testResults?: JsonFile[];
  startTime?: number;
}

/** First non-empty line of a failure message, for a compact `line` fallback. */
function lineFromMessage(msg: string | undefined): number | null {
  if (!msg) return null;
  // vitest failure messages carry a "at file:line:col" or "(file:line:col)" tail.
  const m = msg.match(/:(\d+):\d+\)?\s*$/m) ?? msg.match(/:(\d+):\d+/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Strip ANSI escapes and collapse whitespace runs in a reason string. */
function cleanReason(msg: string): string {
  // The CSI body (`[0;31m`) is matched without the leading ESC, so no control
  // character appears in the pattern (hence no no-control-regex disable needed).
  return msg
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse vitest's `--reporter=json` (jest-compatible) output into a bounded,
 * typed summary. On unparseable input returns `{ parseError: true }` with zeroed
 * counts so the caller can fall back to exit-code + stderr tail. `maxFailures`
 * (default {@link MAX_TEST_FAILURES}) lets the tool raise the cap for a higher
 * verbosity level; `truncatedFailures` reflects the applied cap.
 */
export function parseVitestJson(
  raw: string,
  maxFailures: number = MAX_TEST_FAILURES,
): VitestParseResult {
  const obj = extractJsonObject(raw) as VitestJson | null;
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.testResults)) {
    return {
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: null,
      failures: [],
      truncatedFailures: false,
      parseError: true,
    };
  }

  const allFailures: TestFailure[] = [];
  let sumDurations = 0;
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = 0;
  let sawTimes = false;

  for (const file of obj.testResults) {
    if (
      typeof file.startTime === "number" &&
      typeof file.endTime === "number"
    ) {
      sawTimes = true;
      minStart = Math.min(minStart, file.startTime);
      maxEnd = Math.max(maxEnd, file.endTime);
    }
    for (const a of file.assertionResults ?? []) {
      if (typeof a.duration === "number") sumDurations += a.duration;
      if (a.status === "failed") {
        const reasonRaw = (a.failureMessages ?? []).join("\n");
        allFailures.push({
          test: a.fullName || a.title || "(unnamed test)",
          file: file.name ?? null,
          line: a.location?.line ?? lineFromMessage(a.failureMessages?.[0]),
          reason: clipStr(
            cleanReason(reasonRaw) || "(no failure message)",
            MAX_REASON_CHARS,
          ),
        });
      }
    }
  }

  // Prefer wall-clock across files (min start → max end); fall back to summed
  // per-assertion durations. Both are already in the reporter — no clock read.
  const durationMs =
    sawTimes && maxEnd >= minStart ? maxEnd - minStart : sumDurations || null;

  return {
    passed: obj.numPassedTests ?? 0,
    failed: obj.numFailedTests ?? allFailures.length,
    skipped: (obj.numPendingTests ?? 0) + (obj.numTodoTests ?? 0),
    durationMs,
    failures: allFailures.slice(0, maxFailures),
    truncatedFailures: allFailures.length > maxFailures,
  };
}

// ── test_run_unit: deterministic test-file selection ─────────────────────────

/**
 * Sibling / same-name test candidates for a changed source file, by convention:
 * `<dir>/<base>.{test,spec}.{ts,tsx,js,jsx}` and the same under a `<dir>/__tests__/`.
 * Pure — returns candidate paths; the caller checks which exist. Returns [] when
 * `changedFile` is itself already a test file.
 */
export function siblingTestCandidates(changedFile: string): string[] {
  const norm = changedFile.replace(/\\/g, "/");
  if (isTestPath(norm)) return [];
  const slash = norm.lastIndexOf("/");
  const dir = slash === -1 ? "" : norm.slice(0, slash);
  const filename = slash === -1 ? norm : norm.slice(slash + 1);
  const base = filename.replace(/\.[^.]+$/, "");
  if (base === "") return [];
  const kinds = ["test", "spec"];
  const exts = ["ts", "tsx", "js", "jsx"];
  const prefixes =
    dir === "" ? ["", "__tests__/"] : [`${dir}/`, `${dir}/__tests__/`];
  const out: string[] = [];
  for (const prefix of prefixes) {
    for (const kind of kinds) {
      for (const ext of exts) {
        out.push(`${prefix}${base}.${kind}.${ext}`);
      }
    }
  }
  return out;
}

/**
 * A bounded regex that matches an import specifier referencing `base` (the
 * changed module's basename, no extension): the base must be preceded by a path
 * separator or the opening quote and followed by an optional extension then the
 * closing quote — so `./bar`, `../x/bar`, `./bar.js` match but `sidebar` does
 * not. Used with the workspace grep to find test files importing a changed
 * module. Returns null for an empty base.
 */
export function importGrepPattern(changedFile: string): string | null {
  const norm = changedFile.replace(/\\/g, "/");
  const filename = norm.slice(norm.lastIndexOf("/") + 1);
  const base = filename.replace(/\.[^.]+$/, "");
  if (base === "") return null;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // [/'"`] before base = a path segment boundary; optional .ext; then a quote.
  return `[/'"\`]${escaped}(\\.[A-Za-z0-9]+)?['"\`]`;
}

/**
 * From `grep` hits ("file:line:text"), the set of test-file paths, deduped and
 * bounded. Only paths passing {@link isTestPath} are kept — the changed module
 * is imported by many files, but we only want the tests among them.
 */
export function testFilesFromGrepHits(hits: string[], cap: number): string[] {
  const seen = new Set<string>();
  for (const hit of hits) {
    // "file:line:text" — the path is everything before the first ":<digits>:".
    const m = hit.match(/^(.*?):\d+:/);
    const file = m?.[1];
    if (!file || !isTestPath(file)) continue;
    seen.add(file);
    if (seen.size >= cap) break;
  }
  return [...seen];
}

// ── build_execute: tsc error output ──────────────────────────────────────────

export interface BuildError {
  file: string;
  line: number | null;
  code: string | null;
  message: string;
}

export interface TscParseResult {
  errors: BuildError[];
  errorCount: number;
  truncated: boolean;
}

// `file(line,col): error TSxxxx: message` — the tsc `--pretty false` format.
const TSC_ERROR_RE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

/**
 * Parse `tsc --pretty false` output into deduped, file-grouped errors. Identical
 * (file+line+code+message) lines collapse to one; the result is grouped by file
 * (stable order of first appearance) and capped at `maxErrors` (default
 * {@link MAX_BUILD_ERRORS}, raised by higher verbosity). `errorCount` is the
 * total distinct error count BEFORE the cap.
 */
export function parseTscErrors(
  output: string,
  maxErrors: number = MAX_BUILD_ERRORS,
): TscParseResult {
  const seen = new Set<string>();
  const byFile = new Map<string, BuildError[]>();
  let total = 0;
  for (const rawLine of output.split(/\r?\n/)) {
    const m = TSC_ERROR_RE.exec(rawLine.trim());
    if (!m) continue;
    const [, file, line, , code, message] = m;
    const key = `${file}:${line}:${code}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total++;
    const entry: BuildError = {
      file: file ?? "",
      line: Number(line) || null,
      code: code ?? null,
      message: clipStr((message ?? "").trim(), MAX_REASON_CHARS),
    };
    const bucket = byFile.get(entry.file) ?? [];
    bucket.push(entry);
    byFile.set(entry.file, bucket);
  }
  const errors: BuildError[] = [];
  for (const bucket of byFile.values()) {
    for (const e of bucket) {
      if (errors.length >= maxErrors) break;
      errors.push(e);
    }
  }
  return { errors, errorCount: total, truncated: total > errors.length };
}

// ── git_diff_summarize: numstat + unified-diff(U0) parsing ───────────────────

export type ChangeType = "added" | "deleted" | "modified" | "renamed";

export interface DiffFileSummary {
  path: string;
  changeType: ChangeType;
  additions: number;
  deletions: number;
  symbols: string[];
}

export interface DiffSummary {
  files: DiffFileSummary[];
  totals: { files: number; additions: number; deletions: number };
  truncated: boolean;
}

/** Parse `git diff --numstat` → per-path {additions, deletions}. Binary = 0/0. */
export function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number }> {
  const out = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    // "<add>\t<del>\t<path>"; binary shows "-\t-\t<path>"; rename may show
    // "path/{old => new}/x" — we normalise the arrow form to the new path.
    const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!m) continue;
    const additions = m[1] === "-" ? 0 : Number(m[1]);
    const deletions = m[2] === "-" ? 0 : Number(m[2]);
    out.set(normaliseRenamePath(m[3] ?? ""), { additions, deletions });
  }
  return out;
}

/** `a/{b => c}/d` → `a/c/d`; `old => new` → `new`; plain path unchanged. */
function normaliseRenamePath(path: string): string {
  const brace = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, "/");
  const arrow = path.match(/^(.*) => (.*)$/);
  if (arrow) return arrow[2] ?? path;
  return path;
}

// Extract an enclosing declaration name from a hunk-header context string —
// git already puts the enclosing function/class/method after the closing `@@`.
const SYMBOL_NAME_RE =
  /\b(?:function|class|interface|type|enum|const|let|var|def|func|fn|struct|impl|module|namespace)\b[\s*]*([A-Za-z_$][\w$]*)/;
const METHOD_NAME_RE = /([A-Za-z_$][\w$]*)\s*\(/;

/** Best-effort symbol name from a hunk-header context, or null. */
export function symbolFromHunkContext(context: string): string | null {
  const trimmed = context.trim();
  if (trimmed === "") return null;
  const decl = trimmed.match(SYMBOL_NAME_RE);
  if (decl?.[1]) return decl[1];
  const method = trimmed.match(METHOD_NAME_RE);
  if (
    method?.[1] &&
    !["if", "for", "while", "switch", "catch", "return"].includes(method[1])
  ) {
    return method[1];
  }
  return null;
}

/**
 * Parse `git diff -U0` into per-file change type + enclosing symbols. Change
 * type comes from the extended header lines (`new file mode` / `deleted file
 * mode` / `rename from`), symbols from the `@@ … @@ <context>` hunk headers.
 * Returns a map keyed by the file's new path.
 */
export function parseDiffU0(
  output: string,
): Map<string, { changeType: ChangeType; symbols: string[] }> {
  const out = new Map<string, { changeType: ChangeType; symbols: string[] }>();
  // Split into per-file blocks on the "diff --git" boundary.
  const blocks = output.split(/^diff --git /m).slice(1);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const header = lines[0] ?? ""; // "a/path b/path"
    let changeType: ChangeType = "modified";
    let path: string | null = null;
    const symbols: string[] = [];
    const seenSymbols = new Set<string>();

    // Path: prefer the "+++ b/<path>" line; fall back to the header's b/ side.
    for (const line of lines) {
      if (line.startsWith("+++ b/")) path = line.slice("+++ b/".length);
      else if (line.startsWith("+++ ") && line.includes("/dev/null"))
        changeType = "deleted";
      if (line.startsWith("--- ") && line.includes("/dev/null"))
        changeType = "added";
      if (line.startsWith("new file mode")) changeType = "added";
      else if (line.startsWith("deleted file mode")) changeType = "deleted";
      else if (line.startsWith("rename from") || line.startsWith("rename to"))
        changeType = "renamed";
      if (line.startsWith("@@")) {
        // "@@ -a,b +c,d @@ <context>" — context follows the second @@.
        const ctxMatch = line.match(/^@@[^@]*@@\s?(.*)$/);
        const name = symbolFromHunkContext(ctxMatch?.[1] ?? "");
        if (
          name &&
          !seenSymbols.has(name) &&
          symbols.length < MAX_SYMBOLS_PER_FILE
        ) {
          seenSymbols.add(name);
          symbols.push(name);
        }
      }
    }
    if (!path) {
      // Header form "a/<p> b/<p>" (deleted file has no +++ b/ line).
      const hm = header.match(/^a\/(.+?) b\/(.+)$/);
      path = hm?.[2] ?? hm?.[1] ?? null;
    }
    if (path) out.set(normaliseRenamePath(path), { changeType, symbols });
  }
  return out;
}

/**
 * Combine numstat + U0 into the bounded {@link DiffSummary}. `maxFiles` (default
 * {@link MAX_DIFF_FILES}, raised by higher verbosity) caps the file list; totals
 * always reflect every changed file, not just the shown page. Pure.
 */
export function combineDiff(
  numstatOut: string,
  u0Out: string,
  maxFiles: number = MAX_DIFF_FILES,
): DiffSummary {
  const stats = parseNumstat(numstatOut);
  const meta = parseDiffU0(u0Out);
  const paths = new Set<string>([...stats.keys(), ...meta.keys()]);
  const files: DiffFileSummary[] = [];
  let totalAdd = 0;
  let totalDel = 0;
  for (const path of paths) {
    const s = stats.get(path) ?? { additions: 0, deletions: 0 };
    const m = meta.get(path) ?? {
      changeType: "modified" as ChangeType,
      symbols: [],
    };
    totalAdd += s.additions;
    totalDel += s.deletions;
    files.push({
      path,
      changeType: m.changeType,
      additions: s.additions,
      deletions: s.deletions,
      symbols: m.symbols,
    });
  }
  // Stable, deterministic order: most-changed first, then path.
  files.sort(
    (a, b) =>
      b.additions + b.deletions - (a.additions + a.deletions) ||
      a.path.localeCompare(b.path),
  );
  return {
    files: files.slice(0, maxFiles),
    totals: { files: paths.size, additions: totalAdd, deletions: totalDel },
    truncated: paths.size > maxFiles,
  };
}

// ── workspace_health_check: git status --porcelain=v2 --branch ───────────────

export interface GitHealth {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirtyFiles: number;
}

/** Parse `git status --porcelain=v2 --branch` into a compact health object. */
export function parsePorcelainV2(output: string): GitHealth {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  for (const line of output.split(/\r?\n/)) {
    if (line === "") continue;
    if (line.startsWith("# branch.head ")) {
      const v = line.slice("# branch.head ".length).trim();
      branch = v === "(detached)" ? null : v;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (!line.startsWith("#")) {
      // Ordinary changed (1), renamed/copied (2), unmerged (u), untracked (?),
      // ignored (!) entries each occupy one line. Count everything but ignored.
      if (!line.startsWith("!")) dirty++;
    }
  }
  return { branch, upstream, ahead, behind, dirtyFiles: dirty };
}
