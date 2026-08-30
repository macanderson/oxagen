import { describe, expect, it, beforeEach, vi } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("@oxagen/auth", () => ({ resolveApiKey: h.resolveApiKey }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: h.invoke }));

import { a2aWellKnownRoute } from "./well-known";

function app() {
  const a = new Hono();
  a.route("/.well-known", a2aWellKnownRoute);
  return a;
}

function get(headers: Record<string, string> = {}) {
  return app().request("/.well-known/agent-card.json", {
    method: "GET",
    headers: { host: "api.example.test", ...headers },
  });
}

const fullCard = {
  protocolVersion: "1.0",
  name: "Oxagen Workspace Agent",
  description: "full",
  url: "https://api.example.test/a2a",
  preferredTransport: "JSONRPC",
  version: "1.2.3",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    { id: "chat", name: "Workspace agent", description: "d", tags: ["chat"] },
    { id: "researcher", name: "Researcher", description: "d", tags: ["agent"] },
  ],
  securitySchemes: { apiKey: { type: "http", scheme: "bearer" } },
  security: [{ apiKey: [] }],
  supportsAuthenticatedExtendedCard: false,
};

beforeEach(() => vi.clearAllMocks());

describe("GET /.well-known/agent-card.json", () => {
  it("returns the anonymous base card with no auth header", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.protocolVersion).toBe("1.0");
    expect(card.url).toBe("https://api.example.test/a2a");
    // Base card advertises only the generic chat skill — no workspace agents.
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("chat");
    expect(card.securitySchemes.apiKey.scheme).toBe("bearer");
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("returns the full workspace card for a valid API key", async () => {
    h.resolveApiKey.mockResolvedValue({
      ok: true,
      orgId: "org_1",
      workspaceId: "ws_1",
      apiKeyId: "key_1",
    });
    h.invoke.mockResolvedValue(fullCard);
    const res = await get({ authorization: "Bearer ox_valid" });
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.skills.map((s: { id: string }) => s.id)).toContain(
      "researcher",
    );
    expect(h.invoke).toHaveBeenCalledOnce();
  });

  it("falls back to the base card for an invalid API key", async () => {
    h.resolveApiKey.mockResolvedValue({ ok: false, kind: "invalid" });
    const res = await get({ authorization: "Bearer ox_bad" });
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.skills).toHaveLength(1);
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
