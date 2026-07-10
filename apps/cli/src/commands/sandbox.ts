/**
 * `oxagen sandbox files <sessionId>` — list files/directories inside a durable
 * sandbox session's workspace over the org-scoped /v1 API. Thin shell over the
 * agent.sandbox_file.list capability so the CLI stays in parity with the API,
 * MCP, and agent surfaces.
 *
 * `oxagen sandbox cat <sessionId> <path>` — the read counterpart: print one
 * file's contents (agent.sandbox_file.read). Binary files are emitted as a
 * base64 notice rather than raw bytes so terminals stay usable.
 *
 * `oxagen sandbox logs <sessionId>` — print a session's captured
 * stdout/stderr/command output (agent.sandbox_log.list). `--debug` OFF (the
 * default) shows only program output; `--debug` ON includes command echoes,
 * timings, and other system/debug plumbing.
 */
import { apiPost } from "../lib/api.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

interface SandboxListResponse {
  sandboxes: Array<{
    sessionId: string;
    sessionKey: string | null;
    image: "node" | "python" | "shell" | "agent";
    status: "running" | "idle" | "stopped" | "gone";
    driver: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
  }>;
}

interface SandboxFilesResponse {
  entries: Array<{ path: string; kind: "file" | "dir"; sizeBytes: number }>;
}

interface SandboxFileReadResponse {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  sizeBytes: number;
  truncated: boolean;
}

interface SandboxLogsResponse {
  lines: Array<{
    ts: string;
    stream: "stdout" | "stderr" | "system";
    level: "normal" | "debug";
    command: string;
    seq: number;
    line: string;
    exitCode: number | null;
    durationMs: number | null;
  }>;
}

/**
 * Dim system/debug plumbing so real program output stands out — but only on an
 * interactive TTY. Piped output and the REPL's captured writer stay clean of
 * ANSI escapes.
 */
function dim(s: string): string {
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

export async function handleSandboxList(
  opts: { status?: string; limit?: string; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.status) body.status = opts.status;
  if (opts.limit !== undefined) body.limit = parseInt(opts.limit, 10);

  const res = await apiPost<SandboxListResponse>("agent/sandbox/list", body, writer);

  if (opts.json) {
    writer.write(JSON.stringify(res, null, 2));
    return;
  }

  if (res.sandboxes.length === 0) {
    writer.writeErr("(no sandbox sessions)");
    return;
  }

  for (const s of res.sandboxes) {
    const key = s.sessionKey ? ` key=${s.sessionKey}` : "";
    const last = s.lastUsedAt ? ` last=${s.lastUsedAt}` : "";
    writer.write(
      `${s.sessionId} ${s.status} ${s.image} (${s.driver})${key}${last}`,
    );
  }
}

export async function handleSandboxFiles(
  sessionId: string,
  opts: { path?: string; depth?: string; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const body: Record<string, unknown> = { sessionId };
  if (opts.path) body.path = opts.path;
  if (opts.depth !== undefined) body.depth = parseInt(opts.depth, 10);

  const res = await apiPost<SandboxFilesResponse>("agent/sandbox/files", body, writer);

  if (opts.json) {
    writer.write(JSON.stringify(res, null, 2));
    return;
  }

  if (res.entries.length === 0) {
    writer.writeErr("(empty)");
    return;
  }

  for (const e of res.entries) {
    const marker = e.kind === "dir" ? "d" : "-";
    const size = e.kind === "dir" ? "" : ` ${e.sizeBytes}`;
    writer.write(`${marker} ${e.path}${size}`);
  }
}

export async function handleSandboxCat(
  sessionId: string,
  path: string,
  opts: { maxBytes?: string; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const body: Record<string, unknown> = { sessionId, path };
  if (opts.maxBytes !== undefined) body.maxBytes = parseInt(opts.maxBytes, 10);

  const res = await apiPost<SandboxFileReadResponse>("agent/sandbox/file", body, writer);

  if (opts.json) {
    writer.write(JSON.stringify(res, null, 2));
    return;
  }

  if (res.encoding === "base64") {
    // Never dump raw binary into a terminal; the payload is still available
    // via --json for programmatic use.
    writer.writeErr(
      `(binary file, ${res.sizeBytes} bytes${res.truncated ? ", truncated" : ""} — use --json for the base64 payload)`,
    );
    return;
  }

  writer.write(res.content);
  if (res.truncated) {
    writer.writeErr(`(truncated: file is ${res.sizeBytes} bytes on disk)`);
  }
}

export async function handleSandboxLogs(
  sessionId: string,
  opts: { debug?: boolean; limit?: string; json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const body: Record<string, unknown> = { sessionId };
  // --debug OFF ⇒ only program output (level: "normal"); --debug ON ⇒ omit
  // level so the API returns every line (command echoes, timings, plumbing).
  if (!opts.debug) body.level = "normal";
  if (opts.limit !== undefined) body.limit = parseInt(opts.limit, 10);

  const res = await apiPost<SandboxLogsResponse>("agent/sandbox/logs", body, writer);

  if (opts.json) {
    writer.write(JSON.stringify(res, null, 2));
    return;
  }

  if (res.lines.length === 0) {
    writer.writeErr("(no log lines)");
    return;
  }

  for (const l of res.lines) {
    const text = `[${l.stream}] ${l.line}`;
    // Command echoes/timings ('system') and debug-level lines are plumbing —
    // dim them so genuine program output reads clearly.
    const isMeta = l.stream === "system" || l.level === "debug";
    writer.write(isMeta ? dim(text) : text);
  }
}
