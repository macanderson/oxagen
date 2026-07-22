import { describe, expect, it } from "vitest";
import { integrationConfigure } from "./integration.configure";
import { getCapability } from "../registry";

describe("integration.configure capability", () => {
  // ── input: required field ─────────────────────────────────────────────────

  it("accepts a minimal input with only integrationId", () => {
    const parsed = integrationConfigure.input.parse({
      integrationId: "inst_abc",
    });
    expect(parsed.integrationId).toBe("inst_abc");
  });

  it("rejects input missing integrationId", () => {
    expect(() => integrationConfigure.input.parse({})).toThrow();
  });

  it("rejects integrationId of wrong type", () => {
    expect(() =>
      integrationConfigure.input.parse({ integrationId: 42 }),
    ).toThrow();
  });

  // ── input: optional string fields ─────────────────────────────────────────

  it("passes through displayName when provided", () => {
    const parsed = integrationConfigure.input.parse({
      integrationId: "inst_abc",
      displayName: "My GitHub",
    });
    expect(parsed.displayName).toBe("My GitHub");
  });

  it("leaves displayName undefined when omitted", () => {
    const parsed = integrationConfigure.input.parse({
      integrationId: "inst_abc",
    });
    expect(parsed.displayName).toBeUndefined();
  });

  // ── input: config record ──────────────────────────────────────────────────

  it("passes through a config record", () => {
    const parsed = integrationConfigure.input.parse({
      integrationId: "inst_abc",
      config: { apiKey: "token_123", orgName: "acme" },
    });
    expect(parsed.config).toEqual({ apiKey: "token_123", orgName: "acme" });
  });

  // ── input: syncCadence enum ───────────────────────────────────────────────

  it("accepts syncCadence='manual'", () => {
    const parsed = integrationConfigure.input.parse({
      integrationId: "inst_abc",
      syncCadence: "manual",
    });
    expect(parsed.syncCadence).toBe("manual");
  });

  it("accepts syncCadence='polling'", () => {
    const parsed = integrationConfigure.input.parse({
      integrationId: "inst_abc",
      syncCadence: "polling",
    });
    expect(parsed.syncCadence).toBe("polling");
  });

  it("accepts syncCadence='webhook'", () => {
    const parsed = integrationConfigure.input.parse({
      integrationId: "inst_abc",
      syncCadence: "webhook",
    });
    expect(parsed.syncCadence).toBe("webhook");
  });

  it("rejects an unknown syncCadence value", () => {
    expect(() =>
      integrationConfigure.input.parse({
        integrationId: "inst_abc",
        syncCadence: "cron",
      }),
    ).toThrow();
  });

  // ── output: valid full parse ──────────────────────────────────────────────

  it("parses a valid full output", () => {
    const parsed = integrationConfigure.output.parse({
      integrationId: "inst_abc",
      displayName: "My GitHub",
      syncCadence: "polling",
      updatedAt: "2024-06-01T12:00:00.000Z",
    });
    expect(parsed.integrationId).toBe("inst_abc");
    expect(parsed.displayName).toBe("My GitHub");
    expect(parsed.syncCadence).toBe("polling");
    expect(parsed.updatedAt).toBe("2024-06-01T12:00:00.000Z");
  });

  it("rejects output missing required integrationId", () => {
    expect(() =>
      integrationConfigure.output.parse({
        displayName: "My GitHub",
        syncCadence: "polling",
        updatedAt: "2024-06-01T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output with invalid syncCadence", () => {
    expect(() =>
      integrationConfigure.output.parse({
        integrationId: "inst_abc",
        displayName: "My GitHub",
        syncCadence: "realtime",
        updatedAt: "2024-06-01T12:00:00.000Z",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("configure_integration")).toBe(integrationConfigure);
  });
});
