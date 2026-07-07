import type {
  AgentSandboxFilesListInput,
  AgentSandboxFilesListOutput,
} from "@oxagen/oxagen/contracts/agent.sandbox_file.list";
import { WORKSPACE_ROOT, isSafeWorkspacePath } from "@oxagen/sandbox";
import type { CapabilityContext } from "../types";
import {
  requireDurableDriver,
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
 * today; the rest fail closed via `requireDurableDriver()`.
 */
export async function agentSandboxFilesListHandler(
  input: AgentSandboxFilesListInput,
  ctx: CapabilityContext,
): Promise<AgentSandboxFilesListOutput> {
  const driver = requireDurableDriver();

  const row = await getSessionByPublicId(ctx, input.sessionId);
  if (!row || row.status === "stopped" || row.status === "gone") {
    throw new SandboxSessionNotFoundError(input.sessionId);
  }

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

  // `%y` = entry type (f/d/l/…), `%s` = size in bytes, `%p` = full path,
  // tab-separated and newline-delimited. `-mindepth 1` excludes the starting
  // directory itself; `-maxdepth` bounds the recursion (validated 1-5).
  const command =
    `find ${shellQuote(targetDir)} -mindepth 1 -maxdepth ${input.depth} ` +
    `\\( -type f -o -type d \\) -printf '%y\\t%s\\t%p\\n' 2>/dev/null`;

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
    const handle = await driver.restoreSession(row.snapshotId, specFromRow(row, ctx));
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
 * Parse the fixed `%y\t%s\t%p` find output into normalized entries. Paths are
 * returned workspace-relative (relative to WORKSPACE_ROOT), sorted for
 * deterministic ordering. Non-file/dir types (symlinks, sockets) are dropped.
 */
export function parseFindOutput(stdout: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
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
    entries.push({
      path: relPath,
      kind,
      sizeBytes: Number.isFinite(size) && size >= 0 ? size : 0,
    });
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
