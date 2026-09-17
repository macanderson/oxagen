// register_agent — mint an agent identity in this workspace (MC spec §6.2,
// App. E; #2956). The identity half lives in Postgres: the `agent.agents`
// row, its delegated `iam.principals` row (kind `agent`, acting for the
// registering user), the default agent role, and the long-lived agent
// credential, an API key returned once and never again. The definition half
// is a file in git, written by `commit_agent_definition`; registration
// writes no definition.
//
// A settings write, outside the metering surface: `noBillingGate: true`.
// Roles: org Owner or Admin, checked by the handler (INV-29).
import { z } from "zod";
import { registerCapability } from "../registry";
import { agentHarnessSchema } from "./agent.list";

const MAX_VALIDITY_DAYS = 365;

export const agentRegister = registerCapability({
  name: "register_agent",
  domain: "agent",
  description:
    "Register an agent identity in this workspace: its principal, default role and a long-lived credential shown once. The definition is committed to the repository separately.",
  mode: "sync",
  // The handler acts as the signed-in user or the API key's creator
  // (resolveActingUserId, assertOrgRole, INV-29). The write ships on the API
  // alone: no MCP tool is built for it.
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
      /** The file name of the definition and the last segment of the agent key (ADR-024). */
      slug: z
        .string()
        .min(1)
        .max(18)
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase words joined by hyphens"),
      name: z.string().min(1).max(128),
      description: z.string().max(1024).optional(),
      harness: agentHarnessSchema,
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

export type AgentRegisterInput = z.output<typeof agentRegister.input>;
export type AgentRegisterOutput = z.output<typeof agentRegister.output>;
