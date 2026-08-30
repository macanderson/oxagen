/**
 * Grep fallback for the context resolver (Group 3).
 *
 * The graph is the default context path; this bounded text scan runs ONLY when
 * the graph cannot answer (disabled, empty, or coverage below threshold), and
 * every such fallback is logged with the reason. It walks the working tree,
 * skipping the usual build/vendor dirs, and returns the files whose contents
 * match the query's lexical terms, ranked by hit count — enough to seed a worker
 * when structured context is unavailable.
 *
 * It is deliberately its own small scanner rather than a call into the agent's
 * `grep` tool: the resolver must return `ImpactedFileRef[]`, not a formatted
 * string, and it must run without a permission broker in the loop.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tokenize } from "./traversal.js";
import type { ImpactedFileRef } from "./graph-query.js";

/**
 * Directories never worth scanning. Only these exact names are skipped — any
 * other dot-directory (`.venv`, `.cache`, `.pnpm-store`, …) is still walked.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
]);

/** Cap on files opened and matches returned, so a fallback can't run away. */
const MAX_FILES_SCANNED = 4000;
const MAX_RESULTS = 50;

async function* walk(
  dir: string,
  root: string,
): AsyncGenerator<{ abs: string; rel: string }> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(abs, root);
    } else if (entry.isFile()) {
      yield { abs, rel: relative(root, abs) };
    }
  }
}

/**
 * Scan `cwd` for files matching any lexical term of `query`, returning up to
 * {@link MAX_RESULTS} files ranked by match count. Returns `[]` when the query
 * has no usable terms or nothing matches. Never throws.
 */
export async function grepFallback(
  cwd: string,
  query: string,
  deps: { readFileText?: (abs: string) => Promise<string | null> } = {},
): Promise<ImpactedFileRef[]> {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const read =
    deps.readFileText ??
    (async (abs: string) => {
      try {
        return await readFile(abs, "utf8");
      } catch {
        return null;
      }
    });

  // Case-insensitive OR of the escaped terms.
  const pattern = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(pattern, "gi");

  const hits: { path: string; count: number }[] = [];
  let scanned = 0;
  for await (const { abs, rel } of walk(cwd, cwd)) {
    if (scanned >= MAX_FILES_SCANNED) break;
    scanned++;
    const text = await read(abs);
    if (text === null) continue;
    const matches = text.match(re);
    if (matches && matches.length > 0)
      hits.push({ path: rel, count: matches.length });
  }

  hits.sort((a, b) => b.count - a.count);
  return hits.slice(0, MAX_RESULTS).map((h) => ({
    path: h.path,
    reason: `grep match (${h.count} hit${h.count === 1 ? "" : "s"})`,
  }));
}
