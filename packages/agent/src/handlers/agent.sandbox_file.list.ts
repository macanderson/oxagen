import type {
  AgentSandboxFilesListInput,
  AgentSandboxFilesListOutput,
} from "@oxagen/oxagen/contracts/agent.sandbox_file.list";
import { WORKSPACE_ROOT, isSafeWorkspacePath } from "@oxagen/sandbox";
import type { CapabilityContext } from "../types";
import {
  requireDurableDriverForRow,
  getSessionByPublicId,
  rebindSession,
  markSessionStatus,
  specFromRow,
  touchSession,
  SandboxSessionNotFoundError,
  SandboxSessionGoneError,
} from "./_sandbox-session";

export type { AgentSandboxFilesListInput, AgentSandboxFilesListOutput };

type Entry = AgentSandboxFilesListOutput["entries"][number];

/**
 * List files/directories inside a durable sandbox session's workspace.
 *
 * Driver normalization: rather than adding a per-driver "list files" method
 * (docker/modal/vercel would each report differently — the RISKS note flags
 * exactly this divergence), we run ONE portable `find` command through the
 * shared `execInSession` primitive that `agent.sandbox.exec` already uses. The
 * output format is fixed by our command, so the result is identical on
 * whichever driver is active. Only the Modal driver implements durable sessions
 * today; the rest fail closed via `requireDurableDriverForRow()`.
 */
export async function agentSandboxFilesListHandler(
  input: AgentSandboxFilesListInput,
  ctx: CapabilityContext,
): Promise<AgentSandboxFilesListOutput> {
  const row = await getSessionByPublicId(ctx, input.sessionId);
  if (!row || row.status === "stopped" || row.status === "gone") {
    throw new SandboxSessionNotFoundError(input.sessionId);
  }

  // Resolve the session's own driver (vendor-neutral), not the deployment default.
  const driver = requireDurableDriverForRow(row.driver);

  // Defense in depth: the contract already rejects unsafe paths at the Zod
  // boundary, but re-validate here so no untrusted string can reach the shell
  // even if this handler is ever invoked outside the contract.
  const rel = input.path;
  if (rel !== undefined && !isSafeWorkspacePath(rel)) {
    throw new Error(
      `agent.sandbox.files.list: unsafe path ${JSON.stringify(rel)}`,
    );
  }
  const targetDir = rel ? `${WORKSPACE_ROOT}/${rel}` : WORKSPACE_ROOT;

  // Two sections in one exec so a single restore-retry covers both:
  //
  //  1. `find` — `%y` = entry type (f/d/l/…), `%s` = size, `%p` = full path,
  //     tab-separated and newline-delimited. `-mindepth 1` excludes the starting
  //     directory itself; `-maxdepth` bounds the recursion (validated 1-5).
  //  2. `git ls-files` — the set of paths git considers ignored, collapsed to
  //     whole ignored directories (`--directory` → `node_modules/`) so it never
  //     enumerates a huge ignored tree. Each line is tagged `i\t…` so the parser
  //     can tell it apart from a `find` line (whose `%y` is always f/d/l, never
  //     `i`). Empty when the workspace is not a git repo. Paths are relative to
  //     WORKSPACE_ROOT — the same frame the find paths are normalized into below.
  const findCmd =
    `find ${shellQuote(targetDir)} -mindepth 1 -maxdepth ${input.depth} ` +
    `\\( -type f -o -type d \\) -printf '%y\\t%s\\t%p\\n' 2>/dev/null`;
  const ignoreCmd =
    `git -C ${shellQuote(WORKSPACE_ROOT)} -c core.quotePath=false ls-files ` +
    `-o -i --exclude-standard --directory 2>/dev/null | sed 's/^/i\\t/'`;
  const command = `${findCmd}; ${ignoreCmd}`;

  let result = await driver.execInSession({
    sandboxId: row.sandboxId,
    command,
    timeoutMs: 30_000,
  });

  // The sandbox was reaped between turns. Restore from the last filesystem
  // snapshot and retry once (same recovery contract as agent.sandbox.exec);
  // without a snapshot the workspace is unrecoverable.
  if (result.gone) {
    if (!row.snapshotId) {
      await markSessionStatus(ctx, row.id, "gone");
      throw new SandboxSessionGoneError(input.sessionId);
    }
    const handle = await driver.restoreSession(
      row.snapshotId,
      specFromRow(row, ctx),
    );
    await rebindSession(ctx, row.id, handle.sandboxId);
    result = await driver.execInSession({
      sandboxId: handle.sandboxId,
      command,
      timeoutMs: 30_000,
    });
    if (result.gone) {
      await markSessionStatus(ctx, row.id, "gone");
      throw new SandboxSessionGoneError(input.sessionId);
    }
  }

  await touchSession(ctx, row.id);

  return { entries: parseFindOutput(result.stdout) };
}

/**
 * Parse the combined `find` + `git ls-files` output into normalized entries.
 *
 * Two line shapes share the stream: `find` rows (`%y\t%s\t%p`, `%y` ∈ f/d/l) and
 * git-ignore rows (`i\t<path>`). We collect the ignore set first, then mark each
 * file/dir entry as `gitignored` when its workspace-relative path IS an ignored
 * path or lives UNDER an ignored directory (git collapses those to the dir with
 * `--directory`, so `node_modules/` covers everything beneath it). Paths are
 * returned workspace-relative, sorted for deterministic ordering; non-file/dir
 * types (symlinks, sockets) are dropped.
 */
export function parseFindOutput(stdout: string): Entry[] {
  const lines = stdout.split("\n");

  // Pass 1: the git-ignored paths (trailing slash from `--directory` stripped so
  // a single prefix rule covers both an ignored file and an ignored directory).
  const ignored: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("i\t")) continue;
    const p = line.slice(2).replace(/\/$/, "");
    if (p.length > 0) ignored.push(p);
  }
  const isIgnored = (path: string): boolean =>
    ignored.some((g) => path === g || path.startsWith(`${g}/`));

  // Pass 2: the find entries.
  const entries: Entry[] = [];
  for (const line of lines) {
    if (line.length === 0 || line.startsWith("i\t")) continue;
    const tab1 = line.indexOf("\t");
    const tab2 = line.indexOf("\t", tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const type = line.slice(0, tab1);
    const sizeRaw = line.slice(tab1 + 1, tab2);
    const absPath = line.slice(tab2 + 1);

    const kind = type === "d" ? "dir" : type === "f" ? "file" : null;
    if (kind === null) continue;

    // Strip the workspace root so the client never sees the absolute sandbox
    // path (an implementation detail).
    let relPath = absPath;
    if (relPath.startsWith(`${WORKSPACE_ROOT}/`)) {
      relPath = relPath.slice(WORKSPACE_ROOT.length + 1);
    } else if (relPath === WORKSPACE_ROOT) {
      continue;
    }

    const size = Number.parseInt(sizeRaw, 10);
    const entry: Entry = {
      path: relPath,
      kind,
      sizeBytes: Number.isFinite(size) && size >= 0 ? size : 0,
    };
    // Only set the flag when true — the client treats absent as "not ignored",
    // keeping the payload lean for the common (source-file) case.
    if (isIgnored(relPath)) entry.gitignored = true;
    entries.push(entry);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/**
 * Single-quote a string for POSIX `sh -c`. The value is already restricted to
 * a safe workspace path joined under a constant root, so this is belt-and-
 * suspenders: any embedded single quote is closed, escaped, and reopened.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
