import { z } from "zod";
import { registerCapability } from "../registry";

// A2A (Agent2Agent) protocol v1.0 Agent Card. The card is the discovery
// document an A2A client fetches (at /.well-known/agent-card.json, or via this
// governed capability) to learn a workspace's identity, transport endpoint,
// auth requirements, and the skills it exposes. Field names follow the A2A v1.0
// JSON-RPC binding exactly so off-the-shelf A2A clients interoperate.
//
// This capability is the *management* surface (metered, IAM-gated) for reading
// the card via API/MCP/CLI. The protocol transport itself (POST /a2a JSON-RPC +
// the well-known route) is mounted separately in apps/api, like /mcp.

export const A2A_PROTOCOL_VERSION = "1.0";

/** A single advertised capability — one Oxagen workspace agent maps to one skill. */
export const a2aAgentSkill = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
});
export type A2AAgentSkill = z.output<typeof a2aAgentSkill>;

/** A2A security scheme — Oxagen advertises HTTP Bearer (workspace API key). */
export const a2aSecurityScheme = z.object({
  type: z.literal("http"),
  scheme: z.literal("bearer"),
  description: z.string().optional(),
});

export const a2aAgentCard = z.object({
  protocolVersion: z.literal(A2A_PROTOCOL_VERSION),
  name: z.string(),
  description: z.string(),
  // A2A service endpoint (the JSON-RPC URL clients POST to).
  url: z.string(),
  preferredTransport: z.literal("JSONRPC"),
  // Card/agent version — the platform version, so clients can detect changes.
  version: z.string(),
  provider: z
    .object({ organization: z.string(), url: z.string() })
    .optional(),
  capabilities: z.object({
    streaming: z.boolean(),
    pushNotifications: z.boolean(),
    stateTransitionHistory: z.boolean(),
  }),
  defaultInputModes: z.array(z.string()),
  defaultOutputModes: z.array(z.string()),
  skills: z.array(a2aAgentSkill),
  securitySchemes: z.record(z.string(), a2aSecurityScheme),
  security: z.array(z.record(z.string(), z.array(z.string()))),
  supportsAuthenticatedExtendedCard: z.boolean(),
});
export type A2AAgentCard = z.output<typeof a2aAgentCard>;

export const a2aCardGet = registerCapability({
  name: "get_a2a_card",
  domain: "a2a",
  description:
    "Read the current workspace's A2A (Agent2Agent) protocol Agent Card — the discovery document advertising the workspace's exposed agents as A2A skills, its JSON-RPC transport endpoint, and its authentication scheme",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  mutates: false,
  // Reading the card consumes no AI credits — skip the billing admission gate.
  noBillingGate: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    baseUrl: z
      .string()
      .url()
      .optional()
      .describe(
        "Override the public base URL used to build the card's service endpoint. Defaults to the A2A_PUBLIC_URL env var (or the production API URL).",
      ),
  }),
  output: a2aAgentCard,
});

export type A2ACardGetInput = z.output<typeof a2aCardGet.input>;
export type A2ACardGetOutput = z.output<typeof a2aCardGet.output>;
