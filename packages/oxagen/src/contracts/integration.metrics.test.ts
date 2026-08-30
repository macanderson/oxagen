import { describe, expect, it } from "vitest";
import { integrationMetrics } from "./integration.metrics";
import { getCapability } from "../registry";

describe("integration.metrics capability", () => {
  // ── input: required field ─────────────────────────────────────────────────

  it("accepts a valid integrationId", () => {
    const parsed = integrationMetrics.input.parse({
      integrationId: "inst_abc",
    });
    expect(parsed.integrationId).toBe("inst_abc");
  });

  it("rejects input missing integrationId", () => {
    expect(() => integrationMetrics.input.parse({})).toThrow();
  });

  it("rejects integrationId of wrong type", () => {
    expect(() =>
      integrationMetrics.input.parse({ integrationId: 123 }),
    ).toThrow();
  });

  // ── output: valid full parse with all nullable fields set ─────────────────

  it("parses a valid full output with non-null metric values", () => {
    const parsed = integrationMetrics.output.parse({
      integrationId: "inst_abc",
      pluginId: "github",
      displayName: "Acme GitHub",
      status: "active",
      entityCount: 500,
      entityCountByType: { repo: 30, pull_request: 200, issue: 270 },
      lastSyncAt: "2024-06-01T12:00:00.000Z",
      lastSyncDurationMs: 4500,
      lastErrorAt: null,
      errorMessage: null,
    });
    expect(parsed.integrationId).toBe("inst_abc");
    expect(parsed.pluginId).toBe("github");
    expect(parsed.displayName).toBe("Acme GitHub");
    expect(parsed.status).toBe("active");
    expect(parsed.entityCount).toBe(500);
    expect(parsed.entityCountByType).toEqual({
      repo: 30,
      pull_request: 200,
      issue: 270,
    });
    expect(parsed.lastSyncAt).toBe("2024-06-01T12:00:00.000Z");
    expect(parsed.lastSyncDurationMs).toBe(4500);
    expect(parsed.lastErrorAt).toBeNull();
    expect(parsed.errorMessage).toBeNull();
  });

  it("parses output with all nullable fields set to null", () => {
    const parsed = integrationMetrics.output.parse({
      integrationId: "inst_new",
      pluginId: "slack",
      displayName: "Slack",
      status: "pending_setup",
      entityCount: 0,
      entityCountByType: {},
      lastSyncAt: null,
      lastSyncDurationMs: null,
      lastErrorAt: null,
      errorMessage: null,
    });
    expect(parsed.lastSyncAt).toBeNull();
    expect(parsed.lastSyncDurationMs).toBeNull();
    expect(parsed.lastErrorAt).toBeNull();
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.entityCountByType).toEqual({});
  });

  it("parses output with lastErrorAt and errorMessage set", () => {
    const parsed = integrationMetrics.output.parse({
      integrationId: "inst_err",
      pluginId: "notion",
      displayName: "Notion",
      status: "failed",
      entityCount: 10,
      entityCountByType: { page: 10 },
      lastSyncAt: "2024-05-30T10:00:00.000Z",
      lastSyncDurationMs: 1000,
      lastErrorAt: "2024-05-31T08:00:00.000Z",
      errorMessage: "API rate limit exceeded",
    });
    expect(parsed.lastErrorAt).toBe("2024-05-31T08:00:00.000Z");
    expect(parsed.errorMessage).toBe("API rate limit exceeded");
    expect(parsed.status).toBe("failed");
  });

  // ── output: status enum ───────────────────────────────────────────────────

  it("accepts status='paused'", () => {
    const parsed = integrationMetrics.output.parse({
      integrationId: "inst_p",
      pluginId: "drive",
      displayName: "Google Drive",
      status: "paused",
      entityCount: 0,
      entityCountByType: {},
      lastSyncAt: null,
      lastSyncDurationMs: null,
      lastErrorAt: null,
      errorMessage: null,
    });
    expect(parsed.status).toBe("paused");
  });

  it("rejects output with unknown status value", () => {
    expect(() =>
      integrationMetrics.output.parse({
        integrationId: "inst_bad",
        pluginId: "drive",
        displayName: "Google Drive",
        status: "inactive",
        entityCount: 0,
        entityCountByType: {},
        lastSyncAt: null,
        lastSyncDurationMs: null,
        lastErrorAt: null,
        errorMessage: null,
      }),
    ).toThrow();
  });

  it("rejects output missing entityCount", () => {
    expect(() =>
      integrationMetrics.output.parse({
        integrationId: "inst_abc",
        pluginId: "github",
        displayName: "GitHub",
        status: "active",
        entityCountByType: {},
        lastSyncAt: null,
        lastSyncDurationMs: null,
        lastErrorAt: null,
        errorMessage: null,
      }),
    ).toThrow();
  });

  it("rejects output missing entityCountByType", () => {
    expect(() =>
      integrationMetrics.output.parse({
        integrationId: "inst_abc",
        pluginId: "github",
        displayName: "GitHub",
        status: "active",
        entityCount: 0,
        lastSyncAt: null,
        lastSyncDurationMs: null,
        lastErrorAt: null,
        errorMessage: null,
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("get_integration_metrics")).toBe(integrationMetrics);
  });
});
