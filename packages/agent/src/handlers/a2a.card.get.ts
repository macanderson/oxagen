import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import {
  A2A_PROTOCOL_VERSION,
  type A2ACardGetInput,
  type A2ACardGetOutput,
  type A2AAgentSkill,
} from "@oxagen/oxagen/contracts/a2a.card.get";
import type { CapabilityContext } from "../types";

export type { A2ACardGetInput, A2ACardGetOutput };

// Platform version stamped onto the card so A2A clients can detect changes.
const PLATFORM_VERSION = process.env.PLATFORM_VERSION ?? "0.0.0";

// Default public base URL for the A2A service endpoint when the caller does not
// pass one (MCP/CLI). The API route always overrides this with the live request
// origin, so this only matters for out-of-band card reads.
function defaultBaseUrl(): string {
  return (
    process.env.A2A_PUBLIC_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "https://api.oxagen.sh"
  );
}

/**
 * Build the workspace's A2A Agent Card.
 *
 * Skills are derived from the workspace's active agent definitions, plus a
 * baseline general-purpose conversational skill (the default agent the A2A
 * `message/send` bridge runs, which exists even when the workspace has defined
 * no custom agents). The card advertises the JSON-RPC transport endpoint and
 * the HTTP Bearer (workspace API key) security scheme.
 */
export async function a2aCardGetHandler(
  input: A2ACardGetInput,
  ctx: CapabilityContext,
): Promise<A2ACardGetOutput> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.agents.publicId,
        slug: schema.agents.slug,
        name: schema.agents.name,
        description: schema.agents.description,
      })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.workspaceId, ctx.workspaceId),
          eq(schema.agents.status, "active"),
          isNull(schema.agents.deletedAt),
        ),
      ),
  );

  const base = (input.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, "");

  const agentSkills: A2AAgentSkill[] = rows.map((r) => ({
    id: r.slug,
    name: r.name,
    description:
      r.description ??
      `The ${r.name} agent, exposed over the Oxagen A2A transport.`,
    tags: ["agent", r.slug],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
  }));

  // Baseline conversational skill — always present. `message/send` with no
  // skill selector runs this general-purpose workspace agent.
  const skills: A2AAgentSkill[] = [
    {
      id: "chat",
      name: "Workspace agent",
      description:
        "General-purpose conversational agent grounded in this workspace's knowledge graph, tools, and connected sources. Send a text message to get a governed, metered agent reply.",
      tags: ["chat", "general", "knowledge-graph"],
      examples: [
        "Summarize what we know about the Acme account.",
        "Which services depend on the billing database?",
      ],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    },
    ...agentSkills,
  ];

  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: "Oxagen Workspace Agent",
    description:
      "An Oxagen workspace exposed over the Agent2Agent (A2A) protocol. Every task is typed, governed, traced, and metered.",
    url: `${base}/a2a`,
    preferredTransport: "JSONRPC",
    version: PLATFORM_VERSION,
    provider: { organization: "Oxagen", url: "https://oxagen.sh" },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills,
    securitySchemes: {
      apiKey: {
        type: "http",
        scheme: "bearer",
        description:
          "Oxagen workspace API key (ox_...) presented as a Bearer token. The key carries org+workspace scope; every A2A task is metered and IAM-gated against it.",
      },
    },
    security: [{ apiKey: [] }],
    supportsAuthenticatedExtendedCard: false,
  };
}
