/**
 * `oxagen sandbox files <sessionId>` — list files/directories inside a durable
 * sandbox session's workspace over the org-scoped /v1 API. Thin shell over the
 * agent.sandbox.files.list capability so the CLI stays in parity with the API,
 * MCP, and agent surfaces.
 */
import { apiPost } from "../lib/api.js";

interface SandboxFilesResponse {
  entries: Array<{ path: string; kind: "file" | "dir"; sizeBytes: number }>;
}

export async function handleSandboxFiles(
  sessionId: string,
  opts: { path?: string; depth?: string; json?: boolean },
): Promise<void> {
  const body: Record<string, unknown> = { sessionId };
  if (opts.path) body.path = opts.path;
  if (opts.depth !== undefined) body.depth = parseInt(opts.depth, 10);

  const res = await apiPost<SandboxFilesResponse>("agent/sandbox/files", body);

  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  if (res.entries.length === 0) {
    process.stderr.write("(empty)\n");
    return;
  }

  for (const e of res.entries) {
    const marker = e.kind === "dir" ? "d" : "-";
    const size = e.kind === "dir" ? "" : ` ${e.sizeBytes}`;
    process.stdout.write(`${marker} ${e.path}${size}\n`);
  }
}
