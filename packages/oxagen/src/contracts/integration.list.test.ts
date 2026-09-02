import { describe, expect, it } from "vitest";
import { integrationList } from "./integration.list";
import { getCapability } from "../registry";

describe("integration.list capability", () => {
  // ── input defaults ────────────────────────────────────────────────────────

  it("defaults limit to 50", () => {
    const parsed = integrationList.input.parse({});
    expect(parsed.limit).toBe(50);
  });

  it("defaults offset to 0", () => {
    const parsed = integrationList.input.parse({});
    expect(parsed.offset).toBe(0);
  });

  it("leaves status undefined when omitted", () => {
    const parsed = integrationList.input.parse({});
    expect(parsed.status).toBeUndefined();
  });

  it("leaves pluginId undefined when omitted", () => {
    const parsed = integrationList.input.parse({});
    expect(parsed.pluginId).toBeUndefined();
  });

  // ── input: limit bounds ───────────────────────────────────────────────────

  it("accepts limit=1 (min)", () => {
    const parsed = integrationList.input.parse({ limit: 1 });
    expect(parsed.limit).toBe(1);
  });

  it("accepts limit=250 (max)", () => {
    const parsed = integrationList.input.parse({ limit: 250 });
    expect(parsed.limit).toBe(250);
  });

  it("rejects limit=0 (below min)", () => {
    expect(() => integrationList.input.parse({ limit: 0 })).toThrow();
  });

  it("rejects limit=251 (above max)", () => {
    expect(() => integrationList.input.parse({ limit: 251 })).toThrow();
  });

  it("rejects a non-integer limit", () => {
    expect(() => integrationList.input.parse({ limit: 1.5 })).toThrow();
  });

  // ── input: offset bounds ──────────────────────────────────────────────────

  it("accepts offset=0 (min)", () => {
    const parsed = integrationList.input.parse({ offset: 0 });
    expect(parsed.offset).toBe(0);
  });

  it("accepts a positive offset", () => {
    const parsed = integrationList.input.parse({ offset: 100 });
    expect(parsed.offset).toBe(100);
  });

  it("rejects a negative offset", () => {
    expect(() => integrationList.input.parse({ offset: -1 })).toThrow();
  });

  it("rejects a non-integer offset", () => {
    expect(() => integrationList.input.parse({ offset: 2.5 })).toThrow();
  });

  // ── input: status enum ────────────────────────────────────────────────────

  it("accepts status='active'", () => {
    const parsed = integrationList.input.parse({ status: "active" });
    expect(parsed.status).toBe("active");
  });

  it("accepts status='paused'", () => {
    const parsed = integrationList.input.parse({ status: "paused" });
    expect(parsed.status).toBe("paused");
  });

  it("accepts status='failed'", () => {
    const parsed = integrationList.input.parse({ status: "failed" });
    expect(parsed.status).toBe("failed");
  });

  it("accepts status='pending_setup'", () => {
    const parsed = integrationList.input.parse({ status: "pending_setup" });
    expect(parsed.status).toBe("pending_setup");
  });

  it("rejects an unknown status value", () => {
    expect(() => integrationList.input.parse({ status: "disabled" })).toThrow();
  });

  // ── input: optional pluginId ──────────────────────────────────────────────

  it("passes through pluginId when provided", () => {
    const parsed = integrationList.input.parse({ pluginId: "github" });
    expect(parsed.pluginId).toBe("github");
  });

  // ── output: valid full parse ──────────────────────────────────────────────

  it("parses a valid output with integrations", () => {
    const parsed = integrationList.output.parse({
      integrations: [
        {
          id: "inst_1",
          pluginId: "github",
          displayName: "Acme GitHub",
          status: "active",
          version: "1.0.0",
          lastSyncAt: "2024-06-01T12:00:00.000Z",
          entityCount: 100,
          errorMessage: null,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      total: 1,
      hasMore: false,
    });
    expect(parsed.integrations).toHaveLength(1);
    expect(parsed.integrations[0]?.id).toBe("inst_1");
    expect(parsed.total).toBe(1);
    expect(parsed.hasMore).toBe(false);
  });

  it("parses an empty integrations array", () => {
    const parsed = integrationList.output.parse({
      integrations: [],
      total: 0,
      hasMore: false,
    });
    expect(parsed.integrations).toHaveLength(0);
    expect(parsed.total).toBe(0);
  });

  it("parses output with hasMore=true", () => {
    const parsed = integrationList.output.parse({
      integrations: [],
      total: 500,
      hasMore: true,
    });
    expect(parsed.hasMore).toBe(true);
  });

  it("parses an integration item with null lastSyncAt and null errorMessage", () => {
    const parsed = integrationList.output.parse({
      integrations: [
        {
          id: "inst_new",
          pluginId: "slack",
          displayName: "Slack",
          status: "pending_setup",
          version: "0.1.0",
          lastSyncAt: null,
          entityCount: 0,
          errorMessage: null,
          createdAt: "2024-05-01T00:00:00.000Z",
        },
      ],
      total: 1,
      hasMore: false,
    });
    expect(parsed.integrations[0]?.lastSyncAt).toBeNull();
    expect(parsed.integrations[0]?.errorMessage).toBeNull();
  });

  it("parses an integration item with a non-null errorMessage", () => {
    const parsed = integrationList.output.parse({
      integrations: [
        {
          id: "inst_err",
          pluginId: "notion",
          displayName: "Notion",
          status: "failed",
          version: "1.0.0",
          lastSyncAt: null,
          entityCount: 0,
          errorMessage: "Token revoked",
          createdAt: "2024-04-01T00:00:00.000Z",
        },
      ],
      total: 1,
      hasMore: false,
    });
    expect(parsed.integrations[0]?.errorMessage).toBe("Token revoked");
  });

  it("rejects output missing total", () => {
    expect(() =>
      integrationList.output.parse({
        integrations: [],
        hasMore: false,
      }),
    ).toThrow();
  });

  it("rejects output missing hasMore", () => {
    expect(() =>
      integrationList.output.parse({
        integrations: [],
        total: 0,
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("list_integrations")).toBe(integrationList);
  });
});
