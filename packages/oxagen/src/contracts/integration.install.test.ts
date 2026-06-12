import { describe, expect, it } from "vitest";
import { integrationInstall } from "./integration.install";
import { getCapability } from "../registry";

describe("integration.install capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("accepts a minimal valid input", () => {
    const parsed = integrationInstall.input.parse({
      pluginId: "github",
      config: { orgName: "acme" },
      displayName: "Acme GitHub",
    });
    expect(parsed.pluginId).toBe("github");
    expect(parsed.displayName).toBe("Acme GitHub");
  });

  it("rejects input missing pluginId", () => {
    expect(() =>
      integrationInstall.input.parse({
        config: {},
        displayName: "My Plugin",
      }),
    ).toThrow();
  });

  it("rejects input missing config", () => {
    expect(() =>
      integrationInstall.input.parse({
        pluginId: "github",
        displayName: "My GitHub",
      }),
    ).toThrow();
  });

  it("rejects input missing displayName", () => {
    expect(() =>
      integrationInstall.input.parse({
        pluginId: "github",
        config: {},
      }),
    ).toThrow();
  });

  it("rejects pluginId of wrong type", () => {
    expect(() =>
      integrationInstall.input.parse({
        pluginId: 42,
        config: {},
        displayName: "My Plugin",
      }),
    ).toThrow();
  });

  // ── input: optional version ───────────────────────────────────────────────

  it("passes through version when provided", () => {
    const parsed = integrationInstall.input.parse({
      pluginId: "github",
      version: "2.1.0",
      config: {},
      displayName: "My GitHub",
    });
    expect(parsed.version).toBe("2.1.0");
  });

  it("leaves version undefined when omitted", () => {
    const parsed = integrationInstall.input.parse({
      pluginId: "github",
      config: {},
      displayName: "My GitHub",
    });
    expect(parsed.version).toBeUndefined();
  });

  // ── input: optional schemaUrl (must be valid URL) ─────────────────────────

  it("accepts a valid HTTPS schemaUrl", () => {
    const parsed = integrationInstall.input.parse({
      pluginId: "custom",
      schemaUrl: "https://example.com/schema.yaml",
      config: {},
      displayName: "Custom Plugin",
    });
    expect(parsed.schemaUrl).toBe("https://example.com/schema.yaml");
  });

  it("rejects an invalid schemaUrl", () => {
    expect(() =>
      integrationInstall.input.parse({
        pluginId: "custom",
        schemaUrl: "not-a-url",
        config: {},
        displayName: "Custom Plugin",
      }),
    ).toThrow();
  });

  it("leaves schemaUrl undefined when omitted", () => {
    const parsed = integrationInstall.input.parse({
      pluginId: "github",
      config: {},
      displayName: "My GitHub",
    });
    expect(parsed.schemaUrl).toBeUndefined();
  });

  // ── input: config record ──────────────────────────────────────────────────

  it("accepts an empty config record", () => {
    const parsed = integrationInstall.input.parse({
      pluginId: "github",
      config: {},
      displayName: "My GitHub",
    });
    expect(parsed.config).toEqual({});
  });

  it("passes through a populated config record", () => {
    const parsed = integrationInstall.input.parse({
      pluginId: "github",
      config: { orgName: "acme", token: "ghs_abc" },
      displayName: "My GitHub",
    });
    expect(parsed.config).toEqual({ orgName: "acme", token: "ghs_abc" });
  });

  // ── output: valid full parse ──────────────────────────────────────────────

  it("parses a valid full output", () => {
    const parsed = integrationInstall.output.parse({
      jobId: "job_inst_001",
      status: "queued",
      pluginId: "github",
      displayName: "Acme GitHub",
    });
    expect(parsed.jobId).toBe("job_inst_001");
    expect(parsed.status).toBe("queued");
    expect(parsed.pluginId).toBe("github");
    expect(parsed.displayName).toBe("Acme GitHub");
  });

  it("rejects output with wrong status literal", () => {
    expect(() =>
      integrationInstall.output.parse({
        jobId: "job_inst_001",
        status: "pending",
        pluginId: "github",
        displayName: "Acme GitHub",
      }),
    ).toThrow();
  });

  it("rejects output missing jobId", () => {
    expect(() =>
      integrationInstall.output.parse({
        status: "queued",
        pluginId: "github",
        displayName: "Acme GitHub",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("integration.install")).toBe(integrationInstall);
  });
});
