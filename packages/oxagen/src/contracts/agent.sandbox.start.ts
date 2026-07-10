import { z } from "zod";
import { registerCapability } from "../registry";

// GitHub owner / repo segments: the safe path charset GitHub itself permits.
const SANDBOX_REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;
// Branch names: printable, no whitespace, and none of the shell metacharacters
// that could break out of the single-quoted context the server-composed clone
// script wraps every value in. C0 control chars are rejected on purpose.
// eslint-disable-next-line no-control-regex -- rejecting C0 control chars in a branch name is the intent
const SANDBOX_REPO_BRANCH = /^[^\s\x00-\x1f`$;&|<>"'\\]+$/;

// ── Durable sandbox sessions ─────────────────────────────────────────────────
// `agent.sandbox.start` provisions (or reconnects to) a LONG-LIVED sandbox that
// survives between agent turns, so a code agent can clone a repo, build a
// feature across many `agent.sandbox.exec` calls, and open a PR without losing
// filesystem/process state. This is the durable counterpart to the one-shot
// `agent.code.execute`; the two coexist.
//
// Reuse: pass a stable `sessionKey` (e.g. the conversation or agent-run id) and
// repeated starts return the SAME warm sandbox (`reused: true`). If the backing
// sandbox was reaped while idle but a filesystem snapshot exists, it is restored
// transparently. Omit `sessionKey` to always provision a fresh session.

export const agentSandboxStart = registerCapability({
  name: "start_sandbox",
  domain: "agent",
  description:
    "Provision or reconnect to a durable code-agent sandbox that persists across turns (clone a repo, build a feature, open a PR). Pass a stable sessionKey to reuse one warm sandbox. Requires SANDBOX_ENABLED=true and a session-capable driver (Modal).",
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
    image: z
      .enum(["node", "python", "shell", "agent"])
      .default("agent")
      .describe(
        "Base image. 'agent' = Debian + git + curl (default, for repo workflows); " +
          "'node'/'python'/'shell' = language base, all with git pre-installed.",
      ),
    sessionKey: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Stable key (e.g. conversation or agent-run id) to reuse one durable " +
          "sandbox across turns. Omit to always create a fresh session.",
      ),
    label: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'Human-friendly name for this sandbox (e.g. "acme-api refactor"), shown ' +
          "in the sandbox list so a person can tell sessions apart. Stored on the " +
          "session's metadata; does not affect reuse (that's sessionKey).",
      ),
    memoryMb: z
      .number()
      .int()
      .min(256)
      .max(8192)
      .default(2048)
      .describe(
        "Memory limit in MiB (durable build sandboxes default higher).",
      ),
    ttlSeconds: z
      .number()
      .int()
      .min(300)
      .max(86_400)
      .default(86_400)
      .describe("Hard ceiling on total session lifetime in seconds (max 24h)."),
    idleTimeoutSeconds: z
      .number()
      .int()
      .min(60)
      .max(86_400)
      .default(1_200)
      .describe(
        "Reap the sandbox after this many seconds of inactivity — the primary " +
          "cost control. A reaped session restores from its last snapshot on the " +
          "next exec.",
      ),
    network: z
      .enum(["allow", "deny"])
      .default("allow")
      .describe(
        "Network policy. Durable build sandboxes default to 'allow' so they can " +
          "clone repos and install dependencies.",
      ),
    setupCmd: z
      .string()
      .max(8192)
      .optional()
      .describe(
        "Optional shell command run ONCE at create time (e.g. `git clone … && pnpm i`). " +
          "Runs with the session's trusted env (bound environment's vault secrets + " +
          "template literal env) injected, so a private-repo clone can authenticate via " +
          "e.g. a GITHUB_TOKEN vault secret: `git clone https://x-access-token:$GITHUB_TOKEN@github.com/org/repo`. " +
          "Git prompts are disabled (GIT_TERMINAL_PROMPT=0); an unauthenticated private " +
          "clone fails fast with a clear error instead of hanging.",
      ),
    repos: z
      .array(
        z.object({
          owner: z
            .string()
            .min(1)
            .max(100)
            .regex(
              SANDBOX_REPO_SEGMENT,
              "owner may contain only letters, digits, '.', '_' and '-'",
            )
            .refine((s) => s !== "." && s !== "..", {
              message: "owner may not be '.' or '..'",
            }),
          repo: z
            .string()
            .min(1)
            .max(200)
            .regex(
              SANDBOX_REPO_SEGMENT,
              "repo may contain only letters, digits, '.', '_' and '-'",
            )
            .refine((s) => s !== "." && s !== "..", {
              message: "repo may not be '.' or '..' (path traversal)",
            }),
          branch: z
            .string()
            .min(1)
            .max(200)
            .regex(
              SANDBOX_REPO_BRANCH,
              "branch may not contain whitespace or shell metacharacters",
            )
            .refine((b) => !b.startsWith("-"), {
              message: "branch may not start with '-'",
            })
            .optional(),
        }),
      )
      .max(8)
      .optional()
      .describe(
        "GitHub repositories to clone into /workspace at provision time. Each is " +
          "cloned (full history) into /workspace/<repo> — a name collision gets an " +
          "-<owner> suffix — using the workspace's GitHub connection token when one " +
          "resolves (private repos) or an anonymous HTTPS clone (public repos). Pin " +
          "a branch per repo with `branch` (git clone --branch --single-branch). Max " +
          "8. The generated clone script is prepended (via &&) to any `setupCmd`; a " +
          "failed clone fails provisioning (runner 422) rather than half-provisioning.",
      ),
    environmentId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional workspace environment id (env_…) bound to this session. Its vault " +
          "secrets are resolved server-side and injected into every agent.sandbox.exec " +
          "run BELOW the caller-supplied env (caller values win). Trusted vault secrets " +
          "are NOT subject to the reserved-key denylist.",
      ),
    sandboxTemplateId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional sandbox template id (sbx_…). When set, the template's provider " +
          "(must be session-capable), runtime image, resources, and network mode " +
          "provision the session, and its environment + vault secret selection + " +
          "literal env are frozen onto the session so every agent.sandbox.exec run " +
          "sees them. Fails fast before provisioning if the template needs a " +
          "not-yet-implemented network mode or a non-session-capable provider.",
      ),
  }),
  output: z.object({
    sessionId: z
      .string()
      .describe(
        "Opaque durable-session id (sbx_…); pass to agent.sandbox.exec.",
      ),
    status: z.string(),
    image: z.enum(["node", "python", "shell", "agent"]),
    createdAt: z.string(),
    reused: z
      .boolean()
      .describe(
        "True when an existing warm (or snapshot-restored) session was returned.",
      ),
  }),
});

export type AgentSandboxStartInput = z.output<typeof agentSandboxStart.input>;
export type AgentSandboxStartOutput = z.output<typeof agentSandboxStart.output>;
