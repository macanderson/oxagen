/**
 * `oxagen sandbox files <sessionId>` — list files/directories inside a durable
 * sandbox session's workspace over the org-scoped /v1 API. Thin shell over the
 * agent.sandbox_file.list capability so the CLI stays in parity with the API,
 * MCP, and agent surfaces.
 *
 * `oxagen sandbox cat <sessionId> <path>` — the read counterpart: print one
 * file's contents (agent.sandbox_file.read). Binary files are emitted as a
 * base64 notice rather than raw bytes so terminals stay usable.
 */
import { apiPost } from "../lib/api.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

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
