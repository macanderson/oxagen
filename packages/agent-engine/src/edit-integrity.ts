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
import { resolveDisplayPath } from "./tools";

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
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file && typeof d.start === "number") {
      const { line } = ts.getLineAndCharacterOfPosition(d.file, d.start);
      errors.push(`line ${line + 1}: ${msg}`);
    } else {
      errors.push(msg);
    }
  }
  return { supported: true, errors };
}

/**
 * The errors present AFTER an edit whose formatted text was not present BEFORE.
 * A file that was already broken carries those errors in `before`, so they never
 * appear here — only the NEW damage an edit introduces gates the write. Pure.
 */
export function newSyntaxErrors(before: string[], after: string[]): string[] {
  const prior = new Set(before);
  return after.filter((e) => !prior.has(e));
}

/**
 * Per-run (per {@link buildWorkspaceTools} call, i.e. per agent turn) map of
 * normalized path → last-known content hash — the anchor store. A whole-file
 * read records the hash; an edit/write verifies it. Keys are normalized through
 * {@link resolveDisplayPath}(root, path) so a relative and an absolute spelling
 * of the same file share ONE entry.
 */
export class EditIntegrityLedger {
  private readonly root: string;
  private readonly hashes = new Map<string, string>();

  constructor(root: string) {
    this.root = root;
  }

  private key(path: string): string {
    return resolveDisplayPath(this.root, path);
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
