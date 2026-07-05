/**
 * `oxagen file-lock` — CLI parity surface for `agent.file.lock.{acquire,
 * release,list}` (docs/specs/agent-file-locking/plan.md §11(d), OXA-2074).
 *
 * The SAME atomic, Neo4j-backed, cross-process lock (HOLDS_LOCK edge via
 * @oxagen/ontology's acquireFileLock) that write_file/edit_file acquire
 * automatically for every coding-agent turn — exposed here so an operator can
 * hold, list, or force-release a lock directly from the shell, without
 * running a turn. Every subcommand goes through the governed (metered,
 * IAM-gated) /v1 API via lib/api.ts, never the graph directly.
 *
 *   oxagen file-lock list [--path p] [--owner o] [--repo r] [--json]
 *   oxagen file-lock acquire <path> [--owner o] [--repo r] [--action read|write]
 *                            [--ttl-ms n] [--agent-id id] [--execution-id id] [--json]
 *   oxagen file-lock release <lockId> [--json]
 *
 * Every command exits non-zero with a friendly message on an API/auth error
 * (mirrors memory.ts's handleApiError pattern) rather than letting a thrown
 * ApiError crash with a raw stack trace.
 */
import { apiGetOrThrow, apiPostOrThrow, ApiError, printTable } from "../lib/api.js";

/** Print an error and exit(1) — the one-shot CLI failure contract. */
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function handleApiError(err: unknown): never {
  if (err instanceof ApiError) fail(err.message);
  fail(err instanceof Error ? err.message : String(err));
}

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

export async function handleFileLockList(opts: FileLockListCliOptions): Promise<void> {
  try {
    const result = await apiGetOrThrow<FileLockListResult>("agent/file/lock/list", {
      path: opts.path,
      owner: opts.owner,
      repo: opts.repo,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    if (result.locks.length === 0) {
      process.stdout.write("No live file locks.\n");
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
    );
  } catch (err) {
    handleApiError(err);
  }
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
): Promise<void> {
  let action: "read" | "write" | undefined;
  if (opts.action !== undefined) {
    if (opts.action !== "read" && opts.action !== "write") {
      fail(`Invalid --action "${opts.action}". Use "read" or "write".`);
    }
    action = opts.action;
  }
  let ttlMs: number | undefined;
  if (opts.ttlMs !== undefined) {
    ttlMs = parseInt(opts.ttlMs, 10);
    if (Number.isNaN(ttlMs)) fail(`Invalid --ttl-ms "${opts.ttlMs}". Use an integer.`);
  }
  try {
    const result = await apiPostOrThrow<FileLockAcquireResult>("agent/file/lock/acquire", {
      path,
      owner: opts.owner,
      repo: opts.repo,
      action,
      ttlMs,
      agentId: opts.agentId,
      executionId: opts.executionId,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    if (result.granted) {
      process.stdout.write(`✓ Lock granted — lockId ${result.lockId}.\n`);
    } else {
      const until = result.blockedUntil ? new Date(result.blockedUntil).toISOString() : "unknown";
      process.stdout.write(
        `✗ Lock not granted — held by ${result.heldBy ?? "another agent"} until ${until}.\n`,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    handleApiError(err);
  }
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
): Promise<void> {
  try {
    const result = await apiPostOrThrow<FileLockReleaseResult>("agent/file/lock/release", {
      lockId,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    if (result.released) {
      process.stdout.write(`✓ Released lock ${lockId}.\n`);
    } else {
      process.stdout.write(`No matching live lock for ${lockId} (already released or expired).\n`);
    }
  } catch (err) {
    handleApiError(err);
  }
}
