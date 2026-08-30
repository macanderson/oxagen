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

  const res = await apiPost<SandboxListResponse>(
    "agent/sandbox/list",
    body,
    writer,
  );

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

  const res = await apiPost<SandboxFilesResponse>(
    "agent/sandbox/files",
    body,
    writer,
  );

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

  const res = await apiPost<SandboxFileReadResponse>(
    "agent/sandbox/file",
    body,
    writer,
  );

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

  const res = await apiPost<SandboxLogsResponse>(
    "agent/sandbox/logs",
    body,
    writer,
  );

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

interface SandboxRenameResponse {
  sessionId: string;
  label: string;
}

/**
 * `oxagen sandbox rename <sessionId> <label>` — set a durable session's
 * human-friendly display label (agent.sandbox.rename over the org-scoped API).
 */
export async function handleSandboxRename(
  sessionId: string,
  label: string,
  opts: { json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const res = await apiPost<SandboxRenameResponse>(
    "agent/sandbox/rename",
    { sessionId, label },
    writer,
  );

  if (opts.json) {
    writer.write(JSON.stringify(res, null, 2));
    return;
  }
  writer.write(`${res.sessionId} renamed to ${JSON.stringify(res.label)}`);
}

/** The start contract's per-repo shape ({ owner, repo, branch? }). */
export interface SandboxRepoSpec {
  owner: string;
  repo: string;
  branch?: string;
}

interface SandboxStartResponse {
  sessionId: string;
  status: string;
  image: "node" | "python" | "shell" | "agent";
  createdAt: string;
  reused: boolean;
}

/**
 * Parse a `--repo owner/name[#branch]` CLI value into the start contract's repo
 * shape. Only splits the convenience form — the full charset / length / path-
 * traversal validation lives server-side in the start_sandbox contract.
 */
export function parseRepoSpec(value: string): SandboxRepoSpec {
  const hash = value.indexOf("#");
  const pathPart = hash >= 0 ? value.slice(0, hash) : value;
  const branch = hash >= 0 ? value.slice(hash + 1) : undefined;
  const slash = pathPart.indexOf("/");
  if (slash <= 0 || slash >= pathPart.length - 1) {
    throw new Error(
      `Invalid --repo "${value}": expected owner/name or owner/name#branch`,
    );
  }
  return {
    owner: pathPart.slice(0, slash),
    repo: pathPart.slice(slash + 1),
    ...(branch ? { branch } : {}),
  };
}

/**
 * `oxagen sandbox warm` — provision (or reuse via --session-key) a durable
 * code-agent sandbox, optionally cloning one or more repos into it at provision
 * time (agent.sandbox.start over the org-scoped API). `--repo` is repeatable.
 */
export async function handleSandboxWarm(
  opts: {
    sessionKey?: string;
    label?: string;
    image?: string;
    repo?: string[];
    json?: boolean;
  },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.sessionKey) body.sessionKey = opts.sessionKey;
  if (opts.label) body.label = opts.label;
  if (opts.image) body.image = opts.image;
  if (opts.repo && opts.repo.length > 0) {
    body.repos = opts.repo.map(parseRepoSpec);
  }

  const res = await apiPost<SandboxStartResponse>(
    "agent/sandbox/start",
    body,
    writer,
  );

  if (opts.json) {
    writer.write(JSON.stringify(res, null, 2));
    return;
  }
  const reused = res.reused ? " (reused)" : "";
  writer.write(`${res.sessionId} ${res.status} ${res.image}${reused}`);
}
