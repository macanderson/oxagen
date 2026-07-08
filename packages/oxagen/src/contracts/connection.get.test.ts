import { describe, expect, it } from "vitest";
import { connectionGet } from "./connection.get";
import { getCapability } from "../registry";

describe("connection.get capability", () => {
  it("parses valid input", () => {
    const parsed = connectionGet.input.parse({ connectionId: "con_ABC123" });
    expect(parsed.connectionId).toBe("con_ABC123");
  });

  it("rejects empty connectionId", () => {
    expect(() => connectionGet.input.parse({ connectionId: "" })).toThrow();
  });

  it("parses valid output with all fields", () => {
    const parsed = connectionGet.output.parse({
      id: "uuid-1",
      publicId: "con_ABC123",
      connectorId: "github",
      displayName: "My GitHub",
      authScheme: "pat",
      deliveryMethod: "webhook",
      deliveryConfig: null,
      status: "active",
      entityCount: 150,
      lastSyncAt: "2026-01-01T00:00:00Z",
      errorMessage: null,
      healthStatus: "healthy",
      consecutiveFailureCount: 0,
      lastPollAt: "2026-01-01T00:00:00Z",
      nextPollAt: "2026-01-01T00:15:00Z",
      lastErrorAt: null,
      createdAt: "2025-12-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(parsed.status).toBe("active");
    expect(parsed.entityCount).toBe(150);
    expect(parsed.lastSyncAt).toBe("2026-01-01T00:00:00Z");
    expect(parsed.errorMessage).toBeNull();
  });

  it("parses output with deliveryConfig and errorMessage", () => {
    const parsed = connectionGet.output.parse({
      id: "uuid-2",
      publicId: "con_DEF456",
      connectorId: "zoom",
      displayName: "Zoom Meetings",
      authScheme: "oauth2_authorization_code",
      deliveryMethod: "poll",
      deliveryConfig: { pollIntervalMinutes: 15 },
      status: "error",
      entityCount: 0,
      lastSyncAt: null,
      errorMessage: "OAuth token expired",
      healthStatus: "errored",
      consecutiveFailureCount: 3,
      lastPollAt: "2026-01-10T00:00:00Z",
      nextPollAt: null,
      lastErrorAt: "2026-01-10T00:00:00Z",
      createdAt: "2025-11-01T00:00:00Z",
      updatedAt: "2026-01-10T00:00:00Z",
    });
    expect(parsed.deliveryConfig).toEqual({ pollIntervalMinutes: 15 });
    expect(parsed.errorMessage).toBe("OAuth token expired");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_connection")).toBe(connectionGet);
  });

  it("is a read operation with low risk", () => {
    expect(connectionGet.agent?.requiresApproval).toBe(false);
    expect(connectionGet.agent?.riskLevel).toBe("low");
    expect(connectionGet.agent?.category).toBe("read");
  });
});
