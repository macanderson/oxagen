import { Hono } from "hono";
import { resolveApiKey } from "@oxagen/auth";
import {
  a2aCardGet,
  a2aAgentCard,
  A2A_PROTOCOL_VERSION,
  type A2AAgentCard,
} from "@oxagen/oxagen/contracts/a2a.card.get";
import { invoke } from "@oxagen/oxagen/kernel";
import type { CapabilityContext } from "@oxagen/oxagen";
import { requestBaseUrl } from "./base-url";
import type { AppEnv } from "../../app";

// GET /.well-known/agent-card.json — A2A discovery document.
//
// Optional auth: with a valid workspace API key (Bearer) it returns the full
// workspace card (skills = active agents), reusing the governed a2a.card.get
// capability. Without a key it returns a base card that advertises the JSON-RPC
// endpoint + the Bearer security scheme and a single generic skill, so clients
// can discover the endpoint and learn they must authenticate — without leaking
// any workspace's agent inventory. This route must be mounted BEFORE the
// auth-gated groups so authMiddleware never 401s an anonymous discovery probe.
export const a2aWellKnownRoute = new Hono<AppEnv>();

function baseCard(baseUrl: string): A2AAgentCard {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: "Oxagen Workspace Agent",
    description:
      "An Oxagen workspace exposed over the Agent2Agent (A2A) protocol. Authenticate with a workspace API key (Bearer) to discover the workspace's agents and run governed, metered tasks.",
    url: `${base}/a2a`,
    preferredTransport: "JSONRPC",
    version: process.env.PLATFORM_VERSION ?? "0.0.0",
    provider: { organization: "Oxagen", url: "https://oxagen.sh" },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "chat",
        name: "Workspace agent",
        description:
          "General-purpose conversational agent. Authenticate to run tasks against a specific workspace's knowledge graph, tools, and connected sources.",
        tags: ["chat", "general"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
      },
    ],
    securitySchemes: {
      apiKey: {
        type: "http",
        scheme: "bearer",
        description:
          "Oxagen workspace API key (ox_...) as a Bearer token. Carries org+workspace scope; every A2A task is metered and IAM-gated.",
      },
    },
    security: [{ apiKey: [] }],
    supportsAuthenticatedExtendedCard: false,
  };
}

a2aWellKnownRoute.get("/agent-card.json", async (c) => {
  const baseUrl = requestBaseUrl(c);
  const authHeader = c.req.header("authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const rawKey = authHeader.slice("Bearer ".length).trim();
    const resolved = await resolveApiKey(rawKey);
    if (resolved.ok) {
      const ctx: CapabilityContext = {
        orgId: resolved.orgId,
        workspaceId: resolved.workspaceId,
        userId: null,
        apiKeyId: resolved.apiKeyId,
        requestId: c.get("requestId") ?? crypto.randomUUID(),
        surface: "api",
        messageId: null,
        clientIp: null,
      };
      const card = await invoke(a2aCardGet.name, { baseUrl }, ctx, {
        surface: "api",
      });
      return c.json(a2aAgentCard.parse(card));
    }
    // An invalid/expired key falls through to the anonymous base card rather
    // than 401ing — discovery is meant to be reachable.
  }

  return c.json(baseCard(baseUrl));
});
