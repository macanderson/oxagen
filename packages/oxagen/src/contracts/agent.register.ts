// register_agent — mint an agent in this workspace (ADR-192, #4369; MC spec
// §6.2). An agent is the IAM principal for one operator (the registering
// user) on one runtime with one harness: your laptop with Claude Code is one
// agent. Registration writes the `agent.agents` row with its runtime and
// toolbelt, its delegated `iam.principals` row, the default agent role, the
// first `agent.agent_versions` row (`registered`), and the long-lived agent
// credential, an API key returned once and never again.
//
// The agent carries no prompt and no definition file. It carries a toolbelt,
// which `assign_agent_toolbelt` can change, and a runtime, which
// `move_agent` can change. Each change writes a new version and keeps the
// principal.
//
// - The slug is derived from the name unless the caller types one, cut to 18
//   characters so the agent key stays within 32 (ADR-024). A slug the
//   workspace has ever used is refused with `conflict`, reason
//   `agent_slug_taken`.
// - A live agent that already runs the harness on the runtime is refused with
//   `conflict`, reason `runtime_harness_taken`, and the error names it.
// - With no `toolbeltId` the agent carries the workspace's All tools belt.
//
// A settings write, outside the metering surface: `noBillingGate: true`.
// Roles: org Owner or Admin, checked by the handler (INV-29).
import { z } from "zod";
import { registerCapability } from "../registry";
import { agentHarnessSchema } from "./agent.list";
import { runtimeIdSchema, runtimeRefSchema } from "./runtime.shared";
import { toolbeltIdSchema, toolbeltRefSchema } from "./toolbelt.shared";

const MAX_VALIDITY_DAYS = 365;

/** The longest new agent slug (ADR-024: 6 + 1 + 6 + 1 + 18 = 32 characters of key). */
export const AGENT_SLUG_MAX = 18;

export const agentSlugSchema = z
  .string()
  .min(1)
  .max(AGENT_SLUG_MAX)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase words joined by hyphens");

export const agentRegister = registerCapability({
  name: "register_agent",
  domain: "agent",
  description:
    "Register an agent in this workspace: one operator on one runtime with one harness, carrying a toolbelt. Mints its principal, default role, first version and a long-lived credential shown once.",
  mode: "sync",
  // The handler acts as the signed-in user or the API key's creator
  // (resolveActingUserId, assertOrgRole, INV-29). The write ships on the API
  // alone: no MCP tool is built for it, because it returns a credential.
  surfaces: ["api", "cli"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "identity" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      name: z.string().trim().min(1).max(128),
      /** The last segment of the agent key (ADR-024). Derived from `name` when absent. */
      slug: agentSlugSchema.optional(),
      description: z.string().max(1024).optional(),
      harness: agentHarnessSchema,
      /** The runtime the agent runs on (`create_runtime`). */
      runtimeId: runtimeIdSchema,
      /** The toolbelt the agent carries. The workspace's All tools belt when absent. */
      toolbeltId: toolbeltIdSchema.optional(),
      /** Credential lifetime in days. */
      validityDays: z.number().int().min(1).max(MAX_VALIDITY_DAYS).default(180),
    })
    .strict(),
  output: z
    .object({
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      slug: z.string().min(1),
      agentKey: z.string().nullable(),
      principalId: z.string().regex(/^prn_[0-9a-z]+$/),
      runtime: runtimeRefSchema,
      toolbelt: toolbeltRefSchema,
      /** The first `agent_versions.version`. */
      version: z.number().int().positive(),
      credential: z
        .object({
          id: z.string().regex(/^aky_[0-9a-z]+$/),
          /** Shown once. Never recoverable. */
          secret: z.string().min(1),
          expiresAt: z.string().datetime({ offset: true }),
        })
        .strict(),
    })
    .strict(),
});
