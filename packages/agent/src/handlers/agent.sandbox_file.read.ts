import type {
  AgentSandboxFileReadInput,
  AgentSandboxFileReadOutput,
} from "@oxagen/oxagen/contracts/agent.sandbox_file.read";
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

export type { AgentSandboxFileReadInput, AgentSandboxFileReadOutput };

// Sentinel exit codes for the two expected in-sandbox failure shapes. Chosen
// well outside the 1/2 range common tools use, so a genuine tool failure is
// never mistaken for "file missing".
const EXIT_NOT_FOUND = 44;
const EXIT_NOT_A_FILE = 45;

/**
 * Read one file's contents from a durable sandbox session's workspace.
 *
 * Driver normalization mirrors `agent.sandbox_file.list`: instead of a
 * per-driver "read file" method we run ONE portable shell one-liner through
 * the shared `execInSession` primitive — `wc -c` for the true size, then
 * `head -c maxBytes | base64` for a transport-safe payload. Base64 keeps
 * binary bytes intact through the exec channel's stdout string; the decode
 * happens here, server-side, where we can distinguish real UTF-8 text from
 * binary and label the result accordingly. Only the Modal driver implements
 * durable sessions today; the rest fail closed via `requireDurableDriverForRow()`.
 */
export async function agentSandboxFileReadHandler(
  input: AgentSandboxFileReadInput,
  ctx: CapabilityContext,
): Promise<AgentSandboxFileReadOutput> {
  const row = await getSessionByPublicId(ctx, input.sessionId);
  if (!row || row.status === "stopped" || row.status === "gone") {
    throw new SandboxSessionNotFoundError(input.sessionId);
  }

  // Resolve the session's own driver (vendor-neutral), not the deployment default.
  const driver = requireDurableDriverForRow(row.driver);

  // Defense in depth: the contract already rejects unsafe paths at the Zod
  // boundary, but re-validate here so no untrusted string can reach the shell
  // even if this handler is ever invoked outside the contract.
  if (!isSafeWorkspacePath(input.path)) {
    throw new Error(
      `agent.sandbox_file.read: unsafe path ${JSON.stringify(input.path)}`,
    );
  }
  const target = `${WORKSPACE_ROOT}/${input.path}`;

  // First stdout line: exact on-disk byte size (`wc -c`). Remainder: the first
  // `maxBytes` bytes base64-encoded (line wrapping is stripped on decode).
  // Sentinel exit codes separate "missing"/"not a regular file" from real
  // tool failures.
  const command =
    `f=${shellQuote(target)}; ` +
    `if [ ! -e "$f" ]; then exit ${EXIT_NOT_FOUND}; fi; ` +
    `if [ ! -f "$f" ]; then exit ${EXIT_NOT_A_FILE}; fi; ` +
    `wc -c < "$f" && head -c ${input.maxBytes} "$f" | base64`;

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

  if (result.exitCode === EXIT_NOT_FOUND) {
    throw new Error(
      `agent.sandbox_file.read: no such file in the workspace: ${input.path}`,
    );
  }
  if (result.exitCode === EXIT_NOT_A_FILE) {
    throw new Error(
      `agent.sandbox_file.read: not a regular file (is it a directory?): ${input.path}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `agent.sandbox_file.read: read failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
    );
  }

  return decodeReadOutput(input.path, input.maxBytes, result.stdout);
}

/**
 * Parse the fixed `size\n<base64…>` stdout produced by the read command into
 * the contract output. Exported for direct unit coverage of the text/binary/
 * truncation branches.
 */
export function decodeReadOutput(
  path: string,
  maxBytes: number,
  stdout: string,
): AgentSandboxFileReadOutput {
  const nl = stdout.indexOf("\n");
  const sizeLine = (nl >= 0 ? stdout.slice(0, nl) : stdout).trim();
  const sizeParsed = Number.parseInt(sizeLine, 10);
  if (!Number.isFinite(sizeParsed) || sizeParsed < 0) {
    throw new Error(
      `agent.sandbox_file.read: malformed size line ${JSON.stringify(sizeLine)}`,
    );
  }
  const sizeBytes = sizeParsed;

  // base64 output wraps at 76 columns by default — strip all whitespace.
  const b64 = nl >= 0 ? stdout.slice(nl + 1).replace(/\s+/g, "") : "";
  const bytes = Buffer.from(b64, "base64");
  const truncated = sizeBytes > maxBytes;

  // Binary detection: a NUL byte is never valid text, and any non-UTF-8 byte
  // sequence fails the strict decode. Both fall back to base64 so the payload
  // survives JSON transport losslessly.
  if (!bytes.includes(0)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { path, content: text, encoding: "utf8", sizeBytes, truncated };
    } catch {
      // fall through to base64
    }
  }
  return {
    path,
    content: bytes.toString("base64"),
    encoding: "base64",
    sizeBytes,
    truncated,
  };
}

/**
 * Single-quote a string for POSIX `sh -c`. The value is already restricted to
 * a safe workspace path joined under a constant root, so this is belt-and-
 * suspenders: any embedded single quote is closed, escaped, and reopened.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
