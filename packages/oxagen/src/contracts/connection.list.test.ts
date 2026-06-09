import { describe, expect, it } from "vitest";
import { connectionList } from "./connection.list";
import { getCapability } from "../registry";

describe("connection.list capability", () => {
  it("parses empty input with no filters", () => {
    const parsed = connectionList.input.parse({});
    expect(parsed.status).toBeUndefined();
    expect(parsed.connectorId).toBeUndefined();
  });

  it("parses valid status filter", () => {
    const parsed = connectionList.input.parse({ status: "active" });
    expect(parsed.status).toBe("active");
  });

  it("rejects unknown status", () => {
    expect(() => connectionList.input.parse({ status: "unknown" })).toThrow();
  });

  it("parses connectorId filter", () => {
    const parsed = connectionList.input.parse({ connectorId: "github" });
    expect(parsed.connectorId).toBe("github");
  });

  it("parses valid output", () => {
    const parsed = connectionList.output.parse({
      connections: [
        {
          id: "uuid-1",
          publicId: "con_ABC",
          connectorId: "github",
          displayName: "My GitHub",
          authScheme: "oauth2_authorization_code",
          deliveryMethod: "webhook",
          status: "active",
          entityCount: 42,
          lastSyncAt: "2026-01-01T00:00:00Z",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(parsed.connections).toHaveLength(1);
    expect(parsed.connections[0]?.connectorId).toBe("github");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("connection.list")).toBe(connectionList);
  });
});
