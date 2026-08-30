/**
 * `oxagen file-lock` — CLI parity surface for `agent.file.lock.{acquire,
 * release,list}` (docs/specs/agent-file-locking/plan.md §11(d), OXA-2074).
 *
 * The SAME atomic, Postgres-lease-backed, cross-process lock
 * (`packages/agent/src/file-lock/lease.ts`) that write_file/edit_file acquire
 * automatically for every coding-agent turn — exposed here so an operator can
 * hold, list, or force-release a lock directly from the shell, without
 * running a turn. The lease is projected asynchronously to the Neo4j lineage
 * graph for lineage queries (ADR-021 §5), but the lock itself is Postgres,
 * not Neo4j. Every subcommand goes through the governed (metered, IAM-gated)
 * /v1 API via lib/api.ts, never the database directly.
 *
 *   oxagen file-lock list [--path p] [--owner o] [--repo r] [--json]
 *   oxagen file-lock acquire <path> [--owner o] [--repo r] [--action read|write]
 *                            [--ttl-ms n] [--agent-id id] [--execution-id id] [--json]
 *   oxagen file-lock release <lockId> [--json]
 *
 * Output discipline (ADR-023 §4): `--json` emits one single-line JSON value on
 * stdout (shape preserved); pretty mode prints the human table/summary on
 * stdout; a bad flag exits 2 (usage) and an API failure exits 1 — both as
 * uniform stderr error lines. Writer-parameterized, so it is REPL-bridge safe.
 */
import { apiGetOrThrow, apiPostOrThrow, printTable } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface FileLockListCliOptions {
  path?: string;
  owner?: string;
  repo?: string;
  json?: boolean;
}

interface FileLockRecord {
  lockId: string;
  naturalKey: string;
  agentId: string;
  acquiredAt: number;
  expiresAt: number;
  workspaceId: string;
  action: string;
  executionId: string;
}

interface FileLockListResult {
  locks: FileLockRecord[];
}

export async function handleFileLockList(
  opts: FileLockListCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: FileLockListResult;
  try {
    result = await apiGetOrThrow<FileLockListResult>("agent/file/lock/list", {
      path: opts.path,
      owner: opts.owner,
      repo: opts.repo,
    });
  } catch (err) {
    out.error(err, "api");
    return;
  }
  if (out.isJson) {
    out.data(result);
    return;
  }
  if (result.locks.length === 0) {
    writer.write("No live file locks.");
    return;
  }
  printTable(
    ["LOCK ID", "FILE", "HELD BY", "ACTION", "EXPIRES"],
    result.locks.map((l) => [
      l.lockId,
      l.naturalKey,
      l.agentId,
      l.action,
      new Date(l.expiresAt).toISOString(),
    ]),
    writer,
  );
}

// ---------------------------------------------------------------------------
// acquire
// ---------------------------------------------------------------------------

export interface FileLockAcquireCliOptions {
  owner?: string;
  repo?: string;
  action?: string;
  ttlMs?: string;
  agentId?: string;
  executionId?: string;
  json?: boolean;
}

interface FileLockAcquireResult {
  granted: boolean;
  lockId: string;
  heldBy: string | null;
  blockedUntil: number | null;
}

export async function handleFileLockAcquire(
  path: string,
  opts: FileLockAcquireCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);

  let action: "read" | "write" | undefined;
  if (opts.action !== undefined) {
    if (opts.action !== "read" && opts.action !== "write") {
      process.exitCode = 2;
      out.error(
        `Invalid --action "${opts.action}". Use "read" or "write".`,
        "usage",
      );
      return;
    }
    action = opts.action;
  }
  let ttlMs: number | undefined;
  if (opts.ttlMs !== undefined) {
    ttlMs = parseInt(opts.ttlMs, 10);
    if (Number.isNaN(ttlMs)) {
      process.exitCode = 2;
      out.error(`Invalid --ttl-ms "${opts.ttlMs}". Use an integer.`, "usage");
      return;
    }
  }

  let result: FileLockAcquireResult;
  try {
    result = await apiPostOrThrow<FileLockAcquireResult>(
      "agent/file/lock/acquire",
      {
        path,
        owner: opts.owner,
        repo: opts.repo,
        action,
        ttlMs,
        agentId: opts.agentId,
        executionId: opts.executionId,
      },
    );
  } catch (err) {
    out.error(err, "api");
    return;
  }

  // A denied lock is a real (non-error) result with a non-zero exit so scripts
  // can branch on it; the object shape is unchanged for --json consumers.
  if (!result.granted) process.exitCode = 1;
  out.data(result, () => {
    if (result.granted) return `✓ Lock granted — lockId ${result.lockId}.`;
    const until = result.blockedUntil
      ? new Date(result.blockedUntil).toISOString()
      : "unknown";
    return `✗ Lock not granted — held by ${result.heldBy ?? "another agent"} until ${until}.`;
  });
}

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

export interface FileLockReleaseCliOptions {
  json?: boolean;
}

interface FileLockReleaseResult {
  released: boolean;
}

export async function handleFileLockRelease(
  lockId: string,
  opts: FileLockReleaseCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  let result: FileLockReleaseResult;
  try {
    result = await apiPostOrThrow<FileLockReleaseResult>(
      "agent/file/lock/release",
      {
        lockId,
      },
    );
  } catch (err) {
    out.error(err, "api");
    return;
  }
  out.data(result, () =>
    result.released
      ? `✓ Released lock ${lockId}.`
      : `No matching live lock for ${lockId} (already released or expired).`,
  );
}
