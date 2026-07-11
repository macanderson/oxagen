/**
 * Un-poisonable edits — the tool-layer edit guard (Phase 1, "verified green";
 * see docs/ideas/agentic-cli-roadmap-2026-07-10.md).
 *
 * Two independent, per-mutation checks that run INSIDE the write_file /
 * edit_file tools, before anything touches disk:
 *
 * 1. **Hash anchor (stale-read guard).** `read_file` records a sha256 of the
 *    file's full content; `edit_file` re-hashes the file just before applying
 *    and, when the recorded and current hashes disagree, DENIES the edit with
 *    a message telling the model to re-read. This catches the torn-edit class
 *    where the file drifted between read and edit (a formatter, a parallel
 *    session, the agent's own `bash` command) and `old_string` would splice
 *    into content the model has never seen. No recorded hash ⇒ no check, so
 *    flows that never read (scaffolding via write_file) are unaffected.
 *
 * 2. **Syntax-regression gate.** The guard computes the candidate result of
 *    the mutation IN MEMORY (write_file hands it the full content; edit_file's
 *    exact-match splice is reproduced locally) and parses both the current and
 *    candidate content. A mutation that would INTRODUCE new syntax errors is
 *    denied before any write — there is no write-then-revert window and the
 *    working tree is never torn. Files that already fail to parse stay
 *    editable (only the delta is gated), and the model can declare intentional
 *    breakage (fixtures) with `allow_syntax_errors: true`.
 *
 * Both checks are FAIL-OPEN: an unreadable file, an unsupported extension, or
 * a missing TypeScript module all mean "skip the check", never a denial. Only
 * positive evidence (a real hash mismatch, a real new parse error) denies.
 *
 * The TypeScript compiler is loaded lazily through a computed import specifier
 * so bundlers do not inline it; where it cannot be resolved (a slim packaged
 * runtime) the syntax gate silently disarms while the hash anchor — which has
 * no dependencies — keeps working.
 */
import { createHash } from "node:crypto";
import type { Workspace } from "../types";

// ── Denial messages (model-facing; exported for tests + callers) ────────────

export function staleFileDeniedMessage(path: string): string {
  return (
    `Blocked: ${path} changed on disk after you last read it (content-hash mismatch). ` +
    `Something else modified the file — another process, a formatter, or one of your ` +
    `own bash commands. Re-read the file, then re-issue the edit against its current content.`
  );
}

export function syntaxRegressionDeniedMessage(
  path: string,
  introduced: number,
  firstError: string | undefined,
): string {
  return (
    `Blocked: this change would introduce ${introduced} new syntax error${introduced === 1 ? "" : "s"} ` +
    `in ${path}${firstError ? ` (first: ${firstError})` : ""}. Nothing was written. ` +
    `Check that old_string/new_string splice cleanly at their boundaries — or pass ` +
    `allow_syntax_errors: true if the broken state is intentional (e.g. a test fixture).`
  );
}

// ── Lazy TypeScript loader ───────────────────────────────────────────────────

/** The minimal structural slice of the `typescript` module the gate uses. */
export interface TsLikeModule {
  createSourceFile(
    fileName: string,
    sourceText: string,
    languageVersion: number,
    setParentNodes?: boolean,
    scriptKind?: number,
  ): unknown;
  flattenDiagnosticMessageText(
    messageText: unknown,
    newLine: string,
  ): string;
  ScriptTarget: { Latest: number };
  ScriptKind: { TS: number; TSX: number; JS: number; JSX: number };
}

interface TsParseDiagnostic {
  messageText: unknown;
  start?: number;
}

let tsModulePromise: Promise<TsLikeModule | null> | undefined;

/**
 * Resolve the `typescript` module once, or null where it isn't installed.
 * The specifier is computed so esbuild/webpack leave the import to runtime
 * instead of bundling ~8 MB of compiler into every consumer (the same reason
 * tools-structured shells out to `pnpm exec tsc` rather than importing it).
 */
export function loadTypescript(): Promise<TsLikeModule | null> {
  if (!tsModulePromise) {
    const specifier = "typescript";
    tsModulePromise = import(/* @vite-ignore */ specifier)
      .then((m: { default?: unknown }) => (m.default ?? m) as TsLikeModule)
      .catch(() => null);
  }
  return tsModulePromise;
}

// ── Syntax-error counting ────────────────────────────────────────────────────

const TS_KIND_BY_EXT: Record<string, keyof TsLikeModule["ScriptKind"]> = {
  ts: "TS",
  mts: "TS",
  cts: "TS",
  tsx: "TSX",
  js: "JS",
  mjs: "JS",
  cjs: "JS",
  jsx: "JSX",
};

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/** 1-based line number of a character offset within `content`. */
function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

export interface SyntaxReport {
  count: number;
  /** Short description of the first error, e.g. `line 12: '}' expected.` */
  first?: string;
}

/**
 * Count parse-level errors in `content` for the language implied by `path`.
 * Returns null when the file type is unsupported or (for TS/JS) the compiler
 * module is unavailable — callers treat null as "gate does not apply".
 * Type errors are NOT counted; this is a pure syntax check, so it is fast
 * (single-file parse, no program, no type resolution).
 */
export async function countSyntaxErrors(
  path: string,
  content: string,
  loadTs: () => Promise<TsLikeModule | null> = loadTypescript,
): Promise<SyntaxReport | null> {
  const ext = extensionOf(path);
  if (ext === "json") {
    try {
      JSON.parse(content);
      return { count: 0 };
    } catch (err) {
      return {
        count: 1,
        first: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const kindName = TS_KIND_BY_EXT[ext];
  if (!kindName) return null;
  const ts = await loadTs();
  if (!ts) return null;
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind[kindName],
  );
  // parseDiagnostics is internal-but-stable compiler API: the per-file syntax
  // errors produced by the parser alone (exactly the scope this gate wants).
  const diagnostics =
    (sourceFile as { parseDiagnostics?: TsParseDiagnostic[] })
      .parseDiagnostics ?? [];
  if (diagnostics.length === 0) return { count: 0 };
  const firstDiagnostic = diagnostics[0]!;
  const message = ts.flattenDiagnosticMessageText(
    firstDiagnostic.messageText,
    " ",
  );
  const first =
    firstDiagnostic.start !== undefined
      ? `line ${lineOfOffset(content, firstDiagnostic.start)}: ${message}`
      : message;
  return { count: diagnostics.length, first };
}

// ── The guard ────────────────────────────────────────────────────────────────

export interface EditGuardOptions {
  /** Stale-read hash anchor (default true). */
  hashGuard?: boolean;
  /** Syntax-regression gate (default true). */
  syntaxGuard?: boolean;
  /** Injectable TypeScript loader (tests; default {@link loadTypescript}). */
  loadTs?: () => Promise<TsLikeModule | null>;
}

export type EditVerdict =
  | {
      ok: true;
      /**
       * The candidate post-edit content when the guard could compute it
       * (unique match, or replace_all with ≥1 match) — handed back to
       * {@link EditGuard.noteEditApplied} so the anchor updates without a
       * re-read. Null when the splice could not be reproduced locally.
       */
      newContent: string | null;
    }
  | { ok: false; denial: string };

/**
 * Reproduce the workspace `editFile` exact-match splice in memory. Returns
 * null when the occurrence count would make `editFile` throw — the guard then
 * skips the syntax check and lets the workspace produce its own corrective
 * error (which includes closest-line feedback for the model).
 */
export function computeEditResult(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | null {
  const count = oldString === "" ? 0 : content.split(oldString).length - 1;
  if (replaceAll) {
    if (count === 0) return null;
    return content.split(oldString).join(newString);
  }
  if (count !== 1) return null;
  return content.replace(oldString, newString);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Path key for the anchor map. Same resolution the tools use for display
 * (tools.ts `resolveDisplayPath`, duplicated here to keep guard → tools
 * import-free): relative paths join the workspace root.
 */
function pathKey(root: string, p: string): string {
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return p;
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return base === "" ? `/${p}` : `${base}/${p}`;
}

export interface EditGuard {
  /** Record the file's current full-content hash after a successful read. */
  recordRead(path: string): Promise<void>;
  /** Record a hash for content this process itself just wrote. */
  recordContent(path: string, content: string): void;
  /** Gate an edit_file mutation. Runs BEFORE the workspace edit is applied. */
  checkEdit(
    path: string,
    oldString: string,
    newString: string,
    opts?: { replaceAll?: boolean; allowSyntaxErrors?: boolean },
  ): Promise<EditVerdict>;
  /** Gate a write_file mutation. Runs BEFORE the workspace write. */
  checkWrite(
    path: string,
    content: string,
    opts?: { allowSyntaxErrors?: boolean },
  ): Promise<EditVerdict>;
  /** Refresh the anchor after a successful edit (post-splice content, if known). */
  noteEditApplied(path: string, newContent: string | null): Promise<void>;
}

export function createEditGuard(
  workspace: Workspace,
  options: EditGuardOptions = {},
): EditGuard {
  const hashGuard = options.hashGuard ?? true;
  const syntaxGuard = options.syntaxGuard ?? true;
  const loadTs = options.loadTs ?? loadTypescript;
  /** pathKey → sha256 of the file content as this agent last saw it. */
  const anchors = new Map<string, string>();

  async function readFull(path: string): Promise<string | null> {
    try {
      return await workspace.readFile(path);
    } catch {
      return null;
    }
  }

  async function syntaxDelta(
    path: string,
    before: string | null,
    after: string,
    allowSyntaxErrors: boolean | undefined,
  ): Promise<string | null> {
    if (!syntaxGuard || allowSyntaxErrors) return null;
    const post = await countSyntaxErrors(path, after, loadTs);
    if (post === null || post.count === 0) return null;
    // Only gate the DELTA: a file that already fails to parse stays editable.
    const pre =
      before === null
        ? { count: 0 }
        : ((await countSyntaxErrors(path, before, loadTs)) ?? { count: 0 });
    if (post.count <= pre.count) return null;
    return syntaxRegressionDeniedMessage(path, post.count - pre.count, post.first);
  }

  return {
    async recordRead(path: string): Promise<void> {
      if (!hashGuard && !syntaxGuard) return;
      const content = await readFull(path);
      if (content !== null) anchors.set(pathKey(workspace.root, path), sha256(content));
    },

    recordContent(path: string, content: string): void {
      anchors.set(pathKey(workspace.root, path), sha256(content));
    },

    async checkEdit(path, oldString, newString, opts = {}): Promise<EditVerdict> {
      if (!hashGuard && !syntaxGuard) return { ok: true, newContent: null };
      const current = await readFull(path);
      // Unreadable ⇒ fail open: the workspace edit will surface its own error.
      if (current === null) return { ok: true, newContent: null };

      if (hashGuard) {
        const anchored = anchors.get(pathKey(workspace.root, path));
        if (anchored !== undefined && anchored !== sha256(current)) {
          return { ok: false, denial: staleFileDeniedMessage(path) };
        }
      }

      const newContent = computeEditResult(
        current,
        oldString,
        newString,
        opts.replaceAll ?? false,
      );
      if (newContent !== null) {
        const denial = await syntaxDelta(path, current, newContent, opts.allowSyntaxErrors);
        if (denial) return { ok: false, denial };
      }
      return { ok: true, newContent };
    },

    async checkWrite(path, content, opts = {}): Promise<EditVerdict> {
      if (!syntaxGuard || opts.allowSyntaxErrors) return { ok: true, newContent: content };
      // A missing file has zero pre-existing errors: new files must parse
      // (or be declared broken); overwrites are held to "no worse than before".
      const before = await readFull(path);
      const denial = await syntaxDelta(path, before, content, opts.allowSyntaxErrors);
      if (denial) return { ok: false, denial };
      return { ok: true, newContent: content };
    },

    async noteEditApplied(path, newContent): Promise<void> {
      if (!hashGuard && !syntaxGuard) return;
      if (newContent !== null) {
        this.recordContent(path, newContent);
        return;
      }
      const current = await readFull(path);
      if (current !== null) {
        this.recordContent(path, current);
      } else {
        anchors.delete(pathKey(workspace.root, path));
      }
    },
  };
}
