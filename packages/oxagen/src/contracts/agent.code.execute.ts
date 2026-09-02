import { z } from "zod";
import { validateWorkspaceFiles } from "@oxagen/sandbox/workspace";
import { registerCapability } from "../registry";

// ── Workspace files trust boundary ───────────────────────────────────────────
// `files` lets a caller stage a multi-file workspace (path → contents) into the
// sandbox before the entrypoint runs. The path-confinement, count, and byte
// caps live ONCE in `@oxagen/sandbox/workspace` (the lowest layer); this Zod
// wrapper just surfaces a violation as a field-level parse error. Exported so
// code.patch reuses the exact same boundary — there is no second definition.
export const workspaceFilesSchema = z
  .record(z.string(), z.string())
  .superRefine((files, ctx) => {
    try {
      validateWorkspaceFiles(files);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: e instanceof Error ? e.message : "invalid workspace files",
      });
    }
  });

// ── Sandbox env trust boundary ───────────────────────────────────────────────
// The caller-supplied `env` record is forwarded into the sandbox process. Left
// unfiltered, a caller could override sandbox-internal / host config (PATH,
// LD_PRELOAD, MODAL_*, DATABASE_*…) — privilege escalation / exfiltration. We
// allowlist by shape and denylist reserved names/prefixes, and cap count+size.
// Exported so the handler can re-apply it defensively at the sandbox boundary.

const RESERVED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "HOSTNAME",
  "PWD",
  "USER",
  "TERM",
  "TMPDIR",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
]);
const RESERVED_ENV_PREFIXES = [
  "LD_",
  "MODAL_",
  "VERCEL_",
  "SANDBOX_",
  "CLICKHOUSE_",
  "DATABASE_",
  "AWS_",
  "OXAGEN_",
  "NEO4J_",
  "STRIPE_",
  "BLOB_",
  "INNGEST_",
];
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_KEYS = 32;
const MAX_ENV_BYTES = 8192;

/** True when `key` collides with a reserved sandbox/host env name or prefix. */
export function isReservedEnvKey(key: string): boolean {
  if (RESERVED_ENV_KEYS.has(key)) return true;
  return RESERVED_ENV_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Drop any env entry that is not a POSIX-shaped name, collides with a reserved
 * sandbox/host key/prefix, or would push the record past the key/byte caps.
 * Returns `undefined` when nothing safe remains so the sandbox gets no env at
 * all rather than an empty object.
 */
export function sanitizeSandboxEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  let bytes = 0;
  const enc = new TextEncoder();
  for (const [k, v] of Object.entries(env)) {
    if (count >= MAX_ENV_KEYS) break;
    if (!ENV_KEY_PATTERN.test(k)) continue;
    if (isReservedEnvKey(k)) continue;
    const entryBytes = enc.encode(k).length + enc.encode(v).length;
    if (bytes + entryBytes > MAX_ENV_BYTES) continue;
    out[k] = v;
    count++;
    bytes += entryBytes;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const agentCodeExecute = registerCapability({
  name: "execute_code",
  domain: "agent",
  description:
    "Execute a code snippet in an isolated sandbox and return stdout, stderr, and exit code. Supports node, python, and shell. Requires SANDBOX_ENABLED=true.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "execution" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    language: z.enum(["node", "python", "shell"]).describe("Runtime language"),
    code: z.string().min(1).describe("Source code to execute"),
    files: workspaceFilesSchema
      .optional()
      .describe(
        "Extra files (workspace-relative path → contents) landed into the sandbox " +
          "workspace before the entrypoint runs, so an agent can stage a multi-file " +
          "edit and execute against it. Paths are confined to the workspace root " +
          "(no absolute paths or `..`); capped at 64 files / 5 MiB total.",
      ),
    stdin: z.string().optional().describe("Optional stdin input"),
    // NOTE: env is intentionally NOT transformed at parse time. The handler
    // applies `sanitizeSandboxEnv` to the caller-supplied portion so it can
    // report which reserved keys were stripped (see `output.warnings`) and merge
    // trusted vault secrets (resolved from `environmentId`) BELOW the caller env
    // without the denylist stripping them. `invoke()` always routes through the
    // handler, so the sanitize boundary is never skipped.
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Environment variables to inject. Reserved sandbox/host names and prefixes " +
          "(PATH, LD_*, MODAL_*, DATABASE_*, …) are stripped; capped at 32 keys / 8KB.",
      ),
    environmentId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional workspace environment id (env_…). When set, that environment's " +
          "vault secrets are resolved server-side and injected into the sandbox " +
          "BELOW the caller-supplied env (caller values win). Trusted vault secrets " +
          "are NOT subject to the reserved-key denylist.",
      ),
    sandboxTemplateId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional sandbox template id (sbx_…). When set, the template's provider, " +
          "runtime image, resources, network mode, and vault secret selection + " +
          "literal env are applied to this run; the template's own environment " +
          "supplies the vault secrets. The caller-supplied env still wins on collision.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(300_000)
      .default(30_000)
      .describe("Execution timeout in milliseconds (1s–5min)"),
    memoryMb: z
      .number()
      .int()
      .min(64)
      .max(2048)
      .default(256)
      .describe("Memory limit in MiB"),
    network: z
      .enum(["allow", "deny"])
      .default("deny")
      .describe("Network access policy for the sandbox"),
  }),
  output: z.object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    executionMs: z.number().int(),
    timedOut: z.boolean(),
    oomKilled: z.boolean(),
    warnings: z
      .array(z.string())
      .optional()
      .describe(
        "Non-fatal advisories about the run, e.g. reserved env keys that were " +
          "stripped from the caller-supplied env before execution.",
      ),
  }),
});

export type AgentCodeExecuteInput = z.output<typeof agentCodeExecute.input>;
export type AgentCodeExecuteOutput = z.output<typeof agentCodeExecute.output>;
