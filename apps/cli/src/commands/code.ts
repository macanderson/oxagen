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
