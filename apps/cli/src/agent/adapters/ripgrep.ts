/**
 * Ripgrep integration for the `CwdWorkspace` grep primitive.
 *
 * grep prefers `rg` when it's on PATH — it's dramatically faster on large trees,
 * respects `.gitignore`, and handles binary detection — and falls back to the
 * in-process JS walk when rg is absent or errors. Kept in its own module so the
 * probe and runner are trivially mockable in tests (`vi.mock`) while the
 * workspace's public `createCwdWorkspace(cwd)` signature stays clean.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RG_MAX_BUFFER = 50 * 1024 * 1024;

let probeCache: Promise<boolean> | undefined;

/** Whether `rg` is usable on this host. The probe result is cached per process. */
export function hasRipgrep(): Promise<boolean> {
  if (!probeCache) {
    probeCache = execFileAsync("rg", ["--version"]).then(
      () => true,
      () => false,
    );
  }
  return probeCache;
}

/**
 * Run ripgrep with the given argv in `cwd`. Treats "no matches" (exit 1) as a
 * successful empty result and only reports failure (`ok: false`) for a real
 * error (exit ≥ 2) or a missing binary — the caller then falls back to its JS
 * walk. Args are passed as an argv array (never a shell string), so a pattern
 * or path is never re-interpreted by a shell.
 */
export async function runRipgrep(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd,
      maxBuffer: RG_MAX_BUFFER,
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string };
    // Exit 1 = "no matches": a valid empty result, not a failure.
    if (e.code === 1) return { ok: true, stdout: e.stdout ?? "" };
    return { ok: false, stdout: "" };
  }
}

/**
 * Parse `rg --line-number --no-heading --color=never` output into the workspace
 * `file:line:text` shape, capped at `cap` hits. rg emits `path:line:text`; the
 * path is already relative to the search cwd (a leading `./` is stripped for
 * parity with the JS walker) and the text column is re-clipped to 200 chars.
 */
export function parseRipgrepOutput(stdout: string, cap = 500): string[] {
  const hits: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    // path:line:text — split on the first two colons only; text may contain ':'.
    const first = line.indexOf(":");
    if (first === -1) continue;
    const second = line.indexOf(":", first + 1);
    if (second === -1) continue;
    const rawFile = line.slice(0, first);
    const file = rawFile.startsWith("./") ? rawFile.slice(2) : rawFile;
    const lineNo = line.slice(first + 1, second);
    const text = line.slice(second + 1);
    hits.push(`${file}:${lineNo}:${text.slice(0, 200)}`);
    if (hits.length >= cap) break;
  }
  return hits;
}
