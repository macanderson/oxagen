import { describe, expect, it } from "vitest";
import { integrationGet } from "./integration.get";
import { getCapability } from "../registry";

describe("integration.get capability", () => {
  // ── input: required field ─────────────────────────────────────────────────

  it("accepts a valid integrationId", () => {
    const parsed = integrationGet.input.parse({ integrationId: "inst_abc" });
    expect(parsed.integrationId).toBe("inst_abc");
  });

  it("rejects input missing integrationId", () => {
    expect(() => integrationGet.input.parse({})).toThrow();
  });

  it("rejects integrationId of wrong type", () => {
    expect(() => integrationGet.input.parse({ integrationId: 123 })).toThrow();
  });

  // ── output: valid full parse ──────────────────────────────────────────────

  it("parses a valid full output with all nullable fields set", () => {
    const parsed = integrationGet.output.parse({
      id: "inst_abc",
      pluginId: "github",
      displayName: "My GitHub",
      version: "1.2.0",
      status: "active",
      config: { orgName: "acme" },
      schema: { type: "object" },
      entityCount: 42,
      lastSyncAt: "2024-06-01T12:00:00.000Z",
      errorMessage: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-06-01T12:00:00.000Z",
    });
    expect(parsed.id).toBe("inst_abc");
    expect(parsed.pluginId).toBe("github");
    expect(parsed.displayName).toBe("My GitHub");
    expect(parsed.version).toBe("1.2.0");
    expect(parsed.status).toBe("active");
    expect(parsed.entityCount).toBe(42);
    expect(parsed.lastSyncAt).toBe("2024-06-01T12:00:00.000Z");
    expect(parsed.errorMessage).toBeNull();
  });

  it("parses output with null lastSyncAt and null schema", () => {
    const parsed = integrationGet.output.parse({
      id: "inst_new",
      pluginId: "google-drive",
      displayName: "My Drive",
      version: "0.1.0",
      status: "pending_setup",
      config: {},
      schema: null,
      entityCount: 0,
      lastSyncAt: null,
      errorMessage: null,
      createdAt: "2024-05-01T00:00:00.000Z",
      updatedAt: "2024-05-01T00:00:00.000Z",
    });
    expect(parsed.lastSyncAt).toBeNull();
    expect(parsed.schema).toBeNull();
    expect(parsed.status).toBe("pending_setup");
  });

  it("parses output with a non-null errorMessage", () => {
    const parsed = integrationGet.output.parse({
      id: "inst_err",
      pluginId: "slack",
      displayName: "Broken Slack",
      version: "2.0.0",
      status: "failed",
      config: {},
      schema: null,
      entityCount: 0,
      lastSyncAt: null,
      errorMessage: "OAuth token expired",
      createdAt: "2024-04-01T00:00:00.000Z",
      updatedAt: "2024-04-01T00:00:00.000Z",
    });
    expect(parsed.errorMessage).toBe("OAuth token expired");
    expect(parsed.status).toBe("failed");
  });

  // ── output: status enum ───────────────────────────────────────────────────

  it("accepts status='paused'", () => {
    const parsed = integrationGet.output.parse({
      id: "inst_p",
      pluginId: "notion",
      displayName: "Notion",
      version: "1.0.0",
      status: "paused",
      config: {},
      schema: null,
      entityCount: 5,
      lastSyncAt: null,
      errorMessage: null,
      createdAt: "2024-03-01T00:00:00.000Z",
      updatedAt: "2024-03-01T00:00:00.000Z",
    });
    expect(parsed.status).toBe("paused");
  });

  it("rejects output with unknown status value", () => {
    expect(() =>
      integrationGet.output.parse({
        id: "inst_bad",
        pluginId: "notion",
        displayName: "Notion",
        version: "1.0.0",
        status: "disabled",
        config: {},
        schema: null,
        entityCount: 0,
        lastSyncAt: null,
        errorMessage: null,
        createdAt: "2024-03-01T00:00:00.000Z",
        updatedAt: "2024-03-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing required id", () => {
    expect(() =>
      integrationGet.output.parse({
        pluginId: "github",
        displayName: "My GitHub",
        version: "1.0.0",
        status: "active",
        config: {},
        schema: null,
        entityCount: 0,
        lastSyncAt: null,
        errorMessage: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("get_integration")).toBe(integrationGet);
  });
});
