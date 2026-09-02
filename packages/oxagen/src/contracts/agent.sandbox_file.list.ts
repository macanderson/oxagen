import { z } from "zod";
import { isSafeWorkspacePath } from "@oxagen/sandbox/workspace";
import { registerCapability } from "../registry";

// `agent.sandbox.files.list` lists files/directories inside an existing
// durable sandbox session (from `agent.sandbox.start`), so the web UI's
// workspace-context panel and CLI/MCP callers can show a file tree without an
// `agent.sandbox.exec("ls -R")` round-trip. Read-only — no billing gate,
// mirroring `conversation.files.list`.
//
// NOTE (reconciled against the current tree, see RECONCILE in the tracking
// ticket): the blueprint's draft input field was `sandboxId`, but every
// sibling `agent.sandbox.*` capability (exec/snapshot/stop) names this field
// `sessionId` — the opaque `sbx_…` public id returned by `agent.sandbox.start`
// (the driver's raw sandbox id is an internal registry column, never exposed
// to callers). This capability follows that established naming for
// consistency rather than introducing a second name for the same concept.
//
// Listing is implemented by running a `find` one-liner through the existing
// `execInSession` primitive (the same durable-session exec path
// `agent.sandbox.exec` uses) rather than a new per-driver "list files" method.
// Today only the Modal driver implements durable sessions at all — Docker and
// Vercel fail closed via `requireDurableDriver()`, identically to every other
// `agent.sandbox.*` capability — so normalizing on the shared exec primitive
// means this capability works uniformly on whichever driver is active without
// a second implementation to drift out of sync.
export const agentSandboxFilesList = registerCapability({
  name: "list_sandbox_files",
  domain: "agent",
  description:
    "List files and directories inside a durable sandbox session's workspace.",
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
      .optional()
      .describe(
        "Workspace-relative directory to list (e.g. `src`); defaults to the workspace root.",
      ),
    depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(2)
      .describe("Maximum recursion depth below the listed directory (1-5)."),
  }),
  output: z.object({
    entries: z.array(
      z.object({
        /** Workspace-relative path (relative to the workspace root, not to `path`). */
        path: z.string(),
        kind: z.enum(["file", "dir"]),
        sizeBytes: z.number().int().nonnegative(),
        /**
         * True when git (inside the sandbox) reports this path as ignored by the
         * repo's `.gitignore` rules. Absent when the workspace is not a git repo.
         * Powers the file tree's muted + lock treatment; the client derives
         * "hidden" (dotfile) itself from the path, so only ignore-status — which
         * needs git — is resolved server-side.
         */
        gitignored: z.boolean().optional(),
      }),
    ),
  }),
});

export type AgentSandboxFilesListInput = z.output<
  typeof agentSandboxFilesList.input
>;
export type AgentSandboxFilesListOutput = z.output<
  typeof agentSandboxFilesList.output
>;
