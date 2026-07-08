import { describe, expect, it } from "vitest";
import { connectionCreate } from "./connection.create";
import { getCapability } from "../registry";

describe("connection.create capability", () => {
  it("parses valid minimal input", () => {
    const parsed = connectionCreate.input.parse({
      connectorId: "github",
      displayName: "My GitHub",
      authCredential: { token: "ghs_xxx" },
    });
    expect(parsed.connectorId).toBe("github");
    expect(parsed.displayName).toBe("My GitHub");
    expect(parsed.authCredential).toEqual({ token: "ghs_xxx" });
    expect(parsed.connectionConfig).toBeUndefined();
    expect(parsed.deliveryMethod).toBeUndefined();
  });

  it("parses input with all optional fields", () => {
    const parsed = connectionCreate.input.parse({
      connectorId: "google-drive",
      displayName: "Work Drive",
      authCredential: { access_token: "ya29.xxx", refresh_token: "1//xxx" },
      connectionConfig: { rootFolderId: "abc123" },
      deliveryMethod: "poll",
    });
    expect(parsed.connectionConfig).toEqual({ rootFolderId: "abc123" });
    expect(parsed.deliveryMethod).toBe("poll");
  });

  it("rejects empty connectorId", () => {
    expect(() =>
      connectionCreate.input.parse({
        connectorId: "",
        displayName: "Test",
        authCredential: {},
      }),
    ).toThrow();
  });

  it("rejects empty displayName", () => {
    expect(() =>
      connectionCreate.input.parse({
        connectorId: "github",
        displayName: "",
        authCredential: {},
      }),
    ).toThrow();
  });

  it("rejects displayName over 255 chars", () => {
    expect(() =>
      connectionCreate.input.parse({
        connectorId: "github",
        displayName: "x".repeat(256),
        authCredential: {},
      }),
    ).toThrow();
  });

  it("parses valid output", () => {
    const parsed = connectionCreate.output.parse({
      connectionId: "uuid-1",
      publicId: "con_ABC123",
      status: "pending_setup",
      connectorId: "github",
      displayName: "My GitHub",
    });
    expect(parsed.status).toBe("pending_setup");
    expect(parsed.publicId).toBe("con_ABC123");
  });

  it("rejects output with wrong status", () => {
    expect(() =>
      connectionCreate.output.parse({
        connectionId: "uuid-1",
        publicId: "con_ABC",
        status: "active",
        connectorId: "github",
        displayName: "Test",
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("create_connection")).toBe(connectionCreate);
  });

  it("requires approval", () => {
    expect(connectionCreate.agent?.requiresApproval).toBe(true);
  });

  it("has high sensitivity", () => {
    expect(connectionCreate.sensitivity).toBe("high");
  });

  it("is in the connection domain", () => {
    expect(connectionCreate.domain).toBe("connection");
  });
});
