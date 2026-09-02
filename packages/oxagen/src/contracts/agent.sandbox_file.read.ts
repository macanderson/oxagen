import { z } from "zod";
import { isSafeWorkspacePath } from "@oxagen/sandbox/workspace";
import { registerCapability } from "../registry";

/** Default read size: 256 KiB — plenty for source files, safe for the UI. */
export const SANDBOX_FILE_READ_DEFAULT_MAX_BYTES = 256 * 1024;
/** Hard ceiling on a single read: 1 MiB. Larger files come back truncated. */
export const SANDBOX_FILE_READ_MAX_BYTES = 1024 * 1024;

// `agent.sandbox_file.read` reads one file's contents from an existing durable
// sandbox session (from `agent.sandbox.start`), so the web UI's
// workspace-context panel and CLI/MCP callers can show file contents without
// an `agent.sandbox.exec("cat …")` round-trip. Read-only — no billing gate,
// the direct sibling of `agent.sandbox_file.list` (same field naming: the
// opaque `sbx_…` public id is `sessionId`, the same `isSafeWorkspacePath`
// guard protects the path).
//
// Reading is implemented by running a `head -c … | base64` one-liner through
// the existing `execInSession` primitive (exactly how the list capability
// normalizes on one portable `find` command), so it works uniformly on
// whichever durable driver is active. Only the Modal driver implements durable
// sessions today — the rest fail closed via `requireDurableDriver()`.
//
// Binary safety: content is transported base64 out of the sandbox and decoded
// server-side. Valid UTF-8 text is returned as `encoding: "utf8"`; anything
// with NUL bytes or invalid UTF-8 stays base64 with `encoding: "base64"` so
// the payload survives JSON transport losslessly.
export const agentSandboxFileRead = registerCapability({
  name: "read_sandbox_file",
  domain: "agent",
  description:
    "Read one file's contents from a durable sandbox session's workspace.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "execution" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    sessionId: z
      .string()
      .min(1)
      .describe("Durable-session id (sbx_…) returned by agent.sandbox.start."),
    path: z
      .string()
      .max(1024)
      .refine((p) => isSafeWorkspacePath(p), {
        message:
          "path must be a safe, workspace-relative path (no absolute paths or `..` segments)",
      })
      .describe("Workspace-relative file to read (e.g. `src/index.ts`)."),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(SANDBOX_FILE_READ_MAX_BYTES)
      .default(SANDBOX_FILE_READ_DEFAULT_MAX_BYTES)
      .describe(
        "Maximum number of bytes to return (default 256 KiB, cap 1 MiB). Larger files are truncated.",
      ),
  }),
  output: z.object({
    /** Workspace-relative path of the file that was read (echoes the input). */
    path: z.string(),
    /** File contents — UTF-8 text, or base64 when the file is binary. */
    content: z.string(),
    /** How `content` is encoded: valid UTF-8 text vs. base64 for binary data. */
    encoding: z.enum(["utf8", "base64"]),
    /** Full on-disk size of the file (may exceed the returned bytes). */
    sizeBytes: z.number().int().nonnegative(),
    /** True when the file was larger than `maxBytes` and content was cut. */
    truncated: z.boolean(),
  }),
});

export type AgentSandboxFileReadInput = z.output<
  typeof agentSandboxFileRead.input
>;
export type AgentSandboxFileReadOutput = z.output<
  typeof agentSandboxFileRead.output
>;
