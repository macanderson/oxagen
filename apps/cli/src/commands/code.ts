/**
 * `oxagen code …` — sandboxed code utilities (diff, patch, format) plus
 * semantic code-map retrieval over the org-scoped /v1 API. Thin shell: each
 * command reads/writes local files and delegates the actual computation to the
 * code.diff / code.patch / code.format capabilities so the CLI stays
 * in parity with the API, MCP, and agent surfaces.
 *
 * Output discipline (ADR-023 §4): stdout carries ONLY the answer — the diff, the
 * formatted source or the patched-file list (and with `--json`,
 * one single-line JSON value of the capability response). Progress and summaries
 * ("no changes", the +/- change count, apply/dry-run notes, the file-write
 * confirmation, "no files matched") go to stderr via out.info; every failure is
 * a uniform stderr error line with an exit code (2 usage / 1 runtime) and
 * nothing on stdout. Each handler takes an optional trailing CommandWriter, so
 * it runs inline under the REPL's capture seam without touching process.stdout.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { apiPostOrThrow } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

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
  opts: { path?: string; context?: string; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const before = readFileSync(beforeFile, "utf8");
  const after = readFileSync(afterFile, "utf8");
  const body: Record<string, unknown> = { before, after };
  if (opts.path) body.path = opts.path;
  if (opts.context !== undefined)
    body.contextLines = parseInt(opts.context, 10);

  let res: DiffResponse;
  try {
    res = await apiPostOrThrow<DiffResponse>("code/diff", body);
  } catch (err) {
    out.error(err, "api");
    return;
  }

  if (out.isJson) {
    out.data(res);
    return;
  }
  if (!res.changed) {
    out.info("(no changes)");
    return;
  }
  writer.write(res.diff); // the unified diff IS the answer → stdout
  out.info(`+${res.additions} -${res.deletions}`); // change summary → stderr
}

export async function handleCodeFormat(
  file: string,
  opts: { language?: string; indent?: string; write?: boolean; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const source = readFileSync(file, "utf8");
  const language = opts.language ?? inferLanguage(file);
  if (!language) {
    process.exitCode = 2;
    out.error(
      `Could not infer language for ${file}; pass --language json|python.`,
      "usage",
    );
    return;
  }

  const body: Record<string, unknown> = { language, source };
  if (opts.indent !== undefined) body.indent = parseInt(opts.indent, 10);

  let res: FormatResponse;
  try {
    res = await apiPostOrThrow<FormatResponse>("code/format", body);
  } catch (err) {
    out.error(err, "api");
    return;
  }

  if (opts.write) {
    writeFileSync(file, res.formatted);
    if (out.isJson) {
      out.data(res);
      return;
    }
    // Formatted source went back to the file; keep stdout machine-pure and
    // report the write as progress on stderr.
    out.info(`✓ formatted ${file}${res.changed ? "" : " (already formatted)"}`);
    return;
  }

  out.data(res, () => res.formatted); // formatted source IS the answer → stdout
}

export async function handleCodePatch(
  diffFile: string,
  opts: { dir?: string; write?: boolean; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const diff = readFileSync(diffFile, "utf8");
  const dir = opts.dir ?? ".";
  const files = readWorkspaceForDiff(diff, dir);

  let res: PatchResponse;
  try {
    res = await apiPostOrThrow<PatchResponse>("code/patch", { files, diff });
  } catch (err) {
    out.error(err, "api");
    return;
  }

  // Apply the patch to disk when requested — a side-effect independent of the
  // chosen output format (JSON callers still get the files written).
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
  }

  if (out.isJson) {
    out.data(res);
    return;
  }

  // Pretty: the changed-file list is the answer → stdout…
  for (const f of res.files) {
    writer.write(`${f.status.padEnd(8)} ${f.path}`);
  }
  // …and the apply/dry-run outcome is progress → stderr.
  if (opts.write) {
    out.info(`✓ applied ${res.changedCount} file(s) to ${dir}`);
  } else {
    out.info(
      `(dry run — re-run with --write to apply ${res.changedCount} change(s))`,
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
 * send; the authoritative apply happens server-side in code.patch, so this is a
 * best-effort input gather, not a parser.
 *
 * Confinement is enforced HERE, not only server-side. The diff is untrusted
 * input, and this function reads from the local disk before any server call —
 * so a header naming `../../.ssh/id_rsa` (or an absolute path) would otherwise
 * read that file and ship it to the API in `files`. The server's
 * `assertSafeWorkspacePath` only guards the apply target, and only after the
 * payload has already left this machine. Escaping paths are skipped silently:
 * the server rejects such a diff anyway, and this loop is a gather, not a gate.
 */
function readWorkspaceForDiff(
  diff: string,
  dir: string,
): Record<string, string> {
  const files: Record<string, string> = {};
  const root = resolve(dir);
  for (const line of diff.split("\n")) {
    const m = /^(?:---|\+\+\+) (?:[ab]\/)?(.+?)(?:\t.*)?$/.exec(line);
    if (!m) continue;
    const p = m[1];
    if (!p || p === "/dev/null" || files[p]) continue;
    const abs = resolve(root, p);
    if (abs !== root && !abs.startsWith(root + sep)) continue; // escapes `dir`
    if (existsSync(abs)) files[p] = readFileSync(abs, "utf8");
  }
  return files;
}
