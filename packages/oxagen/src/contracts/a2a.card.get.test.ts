import { describe, expect, it } from "vitest";
import { a2aCardGet, a2aAgentCard, A2A_PROTOCOL_VERSION } from "./a2a.card.get";

describe("a2a.card.get contract", () => {
  it("declares the expected capability metadata", () => {
    expect(a2aCardGet.name).toBe("get_a2a_card");
    expect(a2aCardGet.domain).toBe("a2a");
    expect(a2aCardGet.mode).toBe("sync");
    expect(a2aCardGet.scoped).toBe(true);
    // Read-only: skips the billing admission gate, but stays IAM-gated.
    expect(a2aCardGet.noBillingGate).toBe(true);
    expect(a2aCardGet.defaultEffect).toBe("deny");
    expect(a2aCardGet.surfaces).toEqual(["api", "mcp", "agent"]);
  });

  it("accepts an optional baseUrl input and rejects a non-URL", () => {
    expect(a2aCardGet.input.parse({})).toEqual({});
    expect(a2aCardGet.input.parse({ baseUrl: "https://x.test" })).toEqual({
      baseUrl: "https://x.test",
    });
    expect(() => a2aCardGet.input.parse({ baseUrl: "not-a-url" })).toThrow();
  });

  it("validates a spec-conformant Agent Card as output", () => {
    const card = {
      protocolVersion: A2A_PROTOCOL_VERSION,
      name: "Oxagen Workspace Agent",
      description: "d",
      url: "https://api.test/a2a",
      preferredTransport: "JSONRPC",
      version: "1.0.0",
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: true,
      },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [{ id: "chat", name: "Chat", description: "d", tags: ["chat"] }],
      securitySchemes: { apiKey: { type: "http", scheme: "bearer" } },
      security: [{ apiKey: [] }],
      supportsAuthenticatedExtendedCard: false,
    };
    expect(() => a2aAgentCard.parse(card)).not.toThrow();
    expect(() => a2aCardGet.output.parse(card)).not.toThrow();
  });

  it("rejects a card with the wrong protocol version or transport", () => {
    expect(() => a2aAgentCard.parse({ protocolVersion: "0.9" })).toThrow();
  });
});
