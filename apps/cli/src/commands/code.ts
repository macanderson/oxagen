/**
 * `oxagen code …` — sandboxed code utilities (diff, patch, format) over the
 * org-scoped /v1 API. Thin shell: each command reads/writes local files and
 * delegates the actual computation to the code.diff / code.patch / code.format
 * capabilities so the CLI stays in parity with the API, MCP, and agent surfaces.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiPost } from "../lib/api.js";

interface DiffResponse {
  diff: string;
  changed: boolean;
  additions: number;
  deletions: number;
}

interface FormatResponse {
  formatted: string;
  changed: boolean;
  language: string;
}

interface PatchFile {
  path: string;
  status: "added" | "modified" | "deleted";
  content: string;
}

interface PatchResponse {
  applied: boolean;
  files: PatchFile[];
  changedCount: number;
}

export async function handleCodeDiff(
  beforeFile: string,
  afterFile: string,
  opts: { path?: string; context?: string },
): Promise<void> {
  const before = readFileSync(beforeFile, "utf8");
  const after = readFileSync(afterFile, "utf8");
  const body: Record<string, unknown> = { before, after };
  if (opts.path) body.path = opts.path;
  if (opts.context !== undefined) body.contextLines = parseInt(opts.context, 10);

  const res = await apiPost<DiffResponse>("code/diff", body);
  if (!res.changed) {
    process.stderr.write("(no changes)\n");
    return;
  }
  process.stdout.write(res.diff);
  process.stderr.write(`\n+${res.additions} -${res.deletions}\n`);
}

export async function handleCodeFormat(
  file: string,
  opts: { language?: string; indent?: string; write?: boolean },
): Promise<void> {
  const source = readFileSync(file, "utf8");
  const language = opts.language ?? inferLanguage(file);
  if (!language) {
    process.stderr.write(
      `Could not infer language for ${file}; pass --language json|python.\n`,
    );
    process.exit(1);
  }

  const body: Record<string, unknown> = { language, source };
  if (opts.indent !== undefined) body.indent = parseInt(opts.indent, 10);

  const res = await apiPost<FormatResponse>("code/format", body);
  if (opts.write) {
    writeFileSync(file, res.formatted);
    process.stderr.write(
      `✓ formatted ${file}${res.changed ? "" : " (already formatted)"}\n`,
    );
  } else {
    process.stdout.write(res.formatted);
  }
}

export async function handleCodePatch(
  diffFile: string,
  opts: { dir?: string; write?: boolean },
): Promise<void> {
  const diff = readFileSync(diffFile, "utf8");
  const dir = opts.dir ?? ".";
  const files = readWorkspaceForDiff(diff, dir);

  const res = await apiPost<PatchResponse>("code/patch", { files, diff });
  for (const f of res.files) {
    process.stdout.write(`${f.status.padEnd(8)} ${f.path}\n`);
  }

  if (opts.write) {
    for (const f of res.files) {
      const abs = join(dir, f.path);
      if (f.status === "deleted") {
        if (existsSync(abs)) rmSync(abs);
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
      }
    }
    process.stderr.write(`✓ applied ${res.changedCount} file(s) to ${dir}\n`);
  } else {
    process.stderr.write(
      `(dry run — re-run with --write to apply ${res.changedCount} change(s))\n`,
    );
  }
}

interface CodeMapResponse {
  files: Array<{
    nodeId: string;
    path: string;
    language: string;
    displayName: string;
    domain?: string;
    score: number;
  }>;
  symbols: Array<{
    nodeId: string;
    name: string;
    kind: string;
    path: string;
    startLine: number;
    endLine: number;
    signature: string;
    docComment?: string;
    domain?: string;
    score: number;
  }>;
  calls: Array<{
    callerNodeId: string;
    calleeNodeId: string;
    callerName: string;
    calleeName: string;
  }>;
  recentChanges: Array<{
    commitSha: string;
    message: string;
    authorName: string;
    committedAt: string;
    modifiedFiles: string[];
  }>;
}

export async function handleCodeMap(
  query: string,
  opts: { limit?: string; kinds?: string; domain?: string; json?: boolean },
): Promise<void> {
  const body: Record<string, unknown> = { query };
  if (opts.limit !== undefined) body.limit = parseInt(opts.limit, 10);
  if (opts.domain) body.domain = opts.domain;
  if (opts.kinds) body.kinds = opts.kinds.split(",").map((k) => k.trim());

  const res = await apiPost<CodeMapResponse>("code/map", body);

  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  // Human-readable output
  if (res.files.length === 0) {
    process.stderr.write(`No files matched "${query}"\n`);
    return;
  }

  process.stdout.write(`\nCode map for: ${query}\n`);
  process.stdout.write("─".repeat(60) + "\n");

  process.stdout.write(`\nFiles (${res.files.length}):\n`);
  for (const f of res.files) {
    const domain = f.domain ? ` [${f.domain}]` : "";
    const score = `${(f.score * 100).toFixed(0)}%`;
    process.stdout.write(`  ${f.path}${domain}  ${score}\n`);
  }

  if (res.symbols.length > 0) {
    process.stdout.write(`\nSymbols (${res.symbols.length}):\n`);
    for (const s of res.symbols) {
      const line = `${s.startLine}:${s.endLine}`;
      process.stdout.write(`  ${s.kind.padEnd(10)} ${s.name}  (${s.path}:${line})\n`);
      if (s.docComment) {
        process.stdout.write(`             ${s.docComment.slice(0, 80)}\n`);
      }
    }
  }

  if (res.calls.length > 0) {
    process.stdout.write(`\nCall edges (${res.calls.length}):\n`);
    for (const c of res.calls) {
      process.stdout.write(`  ${c.callerName} → ${c.calleeName}\n`);
    }
  }

  if (res.recentChanges.length > 0) {
    process.stdout.write(`\nRecent changes (${res.recentChanges.length}):\n`);
    for (const ch of res.recentChanges) {
      const date = ch.committedAt.slice(0, 10);
      process.stdout.write(`  ${ch.commitSha.slice(0, 8)}  ${date}  ${ch.authorName}  ${ch.message.split("\n")[0]?.slice(0, 60) ?? ""}\n`);
    }
  }
}

/** json from .json, python from .py; undefined when unknown. */
function inferLanguage(file: string): "json" | "python" | undefined {
  if (file.endsWith(".json")) return "json";
  if (file.endsWith(".py")) return "python";
  return undefined;
}

/**
 * Discover the existing workspace files a diff touches by scanning its ---/+++
 * file headers, then read them from `dir`. This only ASSEMBLES the workspace to
 * send; the authoritative apply (and path-traversal confinement) happens
 * server-side in code.patch, so this is a best-effort input gather, not a parser.
 */
function readWorkspaceForDiff(diff: string, dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const line of diff.split("\n")) {
    const m = /^(?:---|\+\+\+) (?:[ab]\/)?(.+?)(?:\t.*)?$/.exec(line);
    if (!m) continue;
    const p = m[1];
    if (!p || p === "/dev/null" || files[p]) continue;
    const abs = join(dir, p);
    if (existsSync(abs)) files[p] = readFileSync(abs, "utf8");
  }
  return files;
}
