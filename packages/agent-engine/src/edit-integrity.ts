/**
 * Edit integrity — the tool-layer gate that makes every agent file edit
 * hash-anchored, syntactically checked, and auditable (the "un-poisonable
 * edits" property). Three pure primitives plus one per-run ledger, composed by
 * `buildWorkspaceTools`:
 *
 *   - {@link hashContent} — the 16-char sha256 ANCHOR a read pins and the next
 *     write verifies, so an edit built against stale content is refused instead
 *     of silently clobbering a file another agent (or the user) changed
 *     underneath it.
 *   - {@link checkSyntax} — a single-file, synchronous SYNTACTIC check
 *     (`JSON.parse` for `.json`, TypeScript syntactic diagnostics for JS/TS) so
 *     an edit cannot leave a file unparseable without declaring it.
 *   - {@link newSyntaxErrors} — the before/after delta: only NEW damage gates, so
 *     a file that was ALREADY broken never blocks an unrelated edit.
 *   - {@link EditIntegrityLedger} — per-run path → last-known-hash map, the
 *     anchor store a read populates and a write consults.
 *
 * Everything here is pure except the ledger's own map, so it is trivially
 * unit-testable and portable across every `Workspace` implementation.
 */
import { createHash } from "node:crypto";
import { extname } from "node:path";
import ts from "typescript";
import { canonicalPathKey } from "./path-identity";

/** Max formatted syntax messages surfaced per file — keeps tool output bounded. */
const MAX_SYNTAX_ERRORS = 5;

/** JS/TS extensions the TypeScript syntactic check understands. */
const TS_LIKE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/**
 * sha256 hex truncated to 16 chars — the edit ANCHOR. A read records it; the
 * next write against the same path verifies the on-disk content still hashes to
 * it before applying. 16 hex chars (64 bits) is collision-safe across the
 * handful of files a single turn touches while staying short enough to echo in
 * a tool result. Pure.
 */
export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export interface SyntaxCheckResult {
  /** True when the extension is one this checker understands (JSON/JS/TS). */
  supported: boolean;
  /**
   * Formatted `"line N: message"` (or a bare message when no position info)
   * errors, capped at {@link MAX_SYNTAX_ERRORS}. Empty when the content parses.
   */
  errors: string[];
}

/**
 * Single-file, synchronous SYNTACTIC validity check — never a type check.
 *  - `.json` → `JSON.parse`; a parse error becomes one message.
 *  - `.ts`/`.tsx`/`.mts`/`.cts`/`.js`/`.jsx`/`.mjs`/`.cjs` → TypeScript's
 *    transpile-time (syntactic, not semantic) diagnostics, JSX preserved so a
 *    `.tsx` needs no React in scope, each formatted `line N: message` (1-based),
 *    capped at {@link MAX_SYNTAX_ERRORS}.
 *  - anything else → `{ supported: false, errors: [] }` (nothing to check).
 * Pure.
 */
export function checkSyntax(path: string, content: string): SyntaxCheckResult {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") {
    try {
      JSON.parse(content);
      return { supported: true, errors: [] };
    } catch (err) {
      return {
        supported: true,
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }
  if (!TS_LIKE_EXTENSIONS.has(ext)) return { supported: false, errors: [] };
  // transpileModule reports SYNTACTIC (and transform-time) diagnostics only — it
  // never type-checks — which is exactly the "is this file still parseable"
  // signal the gate needs. jsx:Preserve keeps JSX from needing a React import.
  const { diagnostics } = ts.transpileModule(content, {
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve },
  });
  const errors: string[] = [];
  for (const d of diagnostics ?? []) {
    if (errors.length >= MAX_SYNTAX_ERRORS) break;
    // The diagnostic CODE rides in front of the flattened message, which is
    // what makes `errorIdentity` compare "the diagnostic itself" rather than
    // its rendered text (#1353). Without it, two distinct diagnostics that
    // happen to flatten to the same words are one error to the delta, and the
    // second is filtered out as "not new" — the converse free pass the issue
    // names. It is also the form `tsc` itself prints, so an agent reading the
    // rejection can look the code up.
    const msg = `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    if (d.file && typeof d.start === "number") {
      const { line } = ts.getLineAndCharacterOfPosition(d.file, d.start);
      errors.push(`line ${line + 1}: ${msg}`);
    } else {
      errors.push(msg);
    }
  }
  return { supported: true, errors };
}

/** `line 12: Unterminated string literal.` → `Unterminated string literal.` */
const LINE_PREFIX = /^line \d+: /;

/**
 * `Unexpected token } in JSON at position 41` → `Unexpected token }`, and
 * `Unexpected token } in JSON at position 41 (line 3 column 5)` (Node ≥20)
 * strips the same way. `checkSyntax`'s `.json` branch returns
 * `JSON.parse`'s message VERBATIM — no `line N:` prefix — and V8 embeds the
 * byte offset (and, on newer Node, the line/column) it failed at directly in
 * that message. So a JSON parse error's identity was its position exactly the
 * way a TS error's was its line number: an edit that inserts a key above a
 * pre-existing JSON fault shifts the offset, the message text changes, and
 * `newSyntaxErrors` reported the pre-existing fault as newly introduced —
 * the same free-pass-inverted shape #1353 names for TypeScript, one file type
 * over.
 */
const JSON_POSITION =
  /\s+in JSON at position \d+(\s*\(line \d+ column \d+\))?$/;

/**
 * An error's identity: everything except the position it happens to render at.
 *
 * For a TypeScript diagnostic that is `TS<code>: <flattened message>`, which is
 * the pair #1353 asks the comparison to be made on — `checkSyntax` renders the
 * code in so the identity carries it without a second channel to keep in sync.
 * For a `JSON.parse` failure there is no code, so it is the message with V8's
 * embedded offset stripped.
 */
function errorIdentity(error: string): string {
  return error.replace(LINE_PREFIX, "").replace(JSON_POSITION, "");
}

/**
 * The errors present AFTER an edit that were not present BEFORE — only the NEW
 * damage an edit introduces gates the write, so a file that was already broken
 * never blocks an unrelated edit. Pure.
 *
 * Identity is the MESSAGE, not the formatted string, because the formatted
 * string embeds a position — a line number for TS diagnostics, a byte offset
 * (plus, on newer Node, a line/column) for a `JSON.parse` failure. Comparing
 * those made an error's identity its position, so any edit that shifted lines
 * or bytes above a pre-existing error renamed it: adding three imports at the
 * top moved an unterminated string from line 12 to line 15, the old text was
 * not in `prior`, and the agent was told it had introduced an error it had
 * not touched — with the suggested next action pointing at a line unrelated
 * to its task (#1353). A JSON file's fault shifts the same way when a key is
 * inserted above it.
 *
 * Matching keeps MULTIPLICITY, so identity survives a shift without hiding a
 * genuine second instance: two unterminated strings where there was one leaves
 * exactly one error reported, and it is reported with its real (post-edit)
 * line number.
 */
export function newSyntaxErrors(before: string[], after: string[]): string[] {
  const unclaimed = new Map<string, number>();
  for (const error of before) {
    const message = errorIdentity(error);
    unclaimed.set(message, (unclaimed.get(message) ?? 0) + 1);
  }

  const introduced: string[] = [];
  for (const error of after) {
    const message = errorIdentity(error);
    const remaining = unclaimed.get(message) ?? 0;
    if (remaining > 0) {
      unclaimed.set(message, remaining - 1);
      continue;
    }
    introduced.push(error);
  }
  return introduced;
}

/**
 * Per-run (per {@link buildWorkspaceTools} call, i.e. per agent turn) map of
 * normalized path → last-known content hash — the anchor store. A whole-file
 * read records the hash; an edit/write verifies it.
 *
 * Keys go through {@link canonicalPathKey}, so every spelling of one file
 * shares ONE entry. This used to use `resolveDisplayPath`, which joins a root
 * and stops: the relative-versus-absolute case its doc named did work, and
 * `./src/foo.ts`, `src/../src/foo.ts` and `src//foo.ts` each missed. A miss is
 * not a refusal here — an absent entry reads as "never seen this run, nothing
 * to anchor against" — so a second spelling skipped the stale-content check
 * altogether (#1357).
 */
export class EditIntegrityLedger {
  private readonly root: string;
  private readonly hashes = new Map<string, string>();

  constructor(root: string) {
    this.root = root;
  }

  private key(path: string): string {
    return canonicalPathKey(this.root, path);
  }

  /** Record the last-known content hash for `path`. */
  record(path: string, hash: string): void {
    this.hashes.set(this.key(path), hash);
  }

  /**
   * The last recorded hash for `path`, or `undefined` if it was never read or
   * written this run (a file with no entry writes freely — no anchor to check).
   */
  get(path: string): string | undefined {
    return this.hashes.get(this.key(path));
  }
}
