import { describe, expect, it } from "vitest";
import { telemetryErrorCluster } from "./telemetry.error.cluster";
import { getCapability } from "../registry";

describe("telemetry.error.cluster capability", () => {
  it("is registered with the expected surfaces and low sensitivity", () => {
    const cap = getCapability("list_error_clusters");
    expect(cap).toBeDefined();
    expect(cap?.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(cap?.mode).toBe("sync");
    expect(cap?.sensitivity).toBe("low");
    // Callable mid-mission by the coding agent — pure SQL, no model call.
    expect(cap?.agent?.category).toBe("introspection");
    expect(cap?.agent?.requiresApproval).toBe(false);
    expect(cap?.defaultEffect).toBe("deny");
    expect(cap?.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
  });

  it("defaults every input field and accepts an empty object", () => {
    const parsed = telemetryErrorCluster.input.parse({});
    expect(parsed.sinceHours).toBeUndefined();
    expect(parsed.severity).toBeUndefined();
    expect(parsed.source).toBeUndefined();
    expect(parsed.limit).toBeUndefined();
  });

  it("clamps sinceHours to [1, 720]", () => {
    expect(() =>
      telemetryErrorCluster.input.parse({ sinceHours: 0 }),
    ).toThrow();
    expect(() =>
      telemetryErrorCluster.input.parse({ sinceHours: 721 }),
    ).toThrow();
    expect(
      telemetryErrorCluster.input.parse({ sinceHours: 720 }).sinceHours,
    ).toBe(720);
    expect(
      telemetryErrorCluster.input.parse({ sinceHours: 1 }).sinceHours,
    ).toBe(1);
  });

  it("clamps limit to [1, 100]", () => {
    expect(() => telemetryErrorCluster.input.parse({ limit: 0 })).toThrow();
    expect(() => telemetryErrorCluster.input.parse({ limit: 101 })).toThrow();
    expect(telemetryErrorCluster.input.parse({ limit: 100 }).limit).toBe(100);
  });

  it("rejects an out-of-enum severity", () => {
    expect(() =>
      telemetryErrorCluster.input.parse({ severity: "info" }),
    ).toThrow();
    expect(
      telemetryErrorCluster.input.parse({ severity: "fatal" }).severity,
    ).toBe("fatal");
  });

  it("parses a full output shape", () => {
    const out = telemetryErrorCluster.output.parse({
      clusters: [
        {
          fingerprint: "fp1",
          errorClass: "TypeError",
          sampleMessage: "cannot read properties of undefined",
          severity: "error",
          source: "api",
          count: 42,
          firstSeen: "2026-07-05 00:00:00.000",
          lastSeen: "2026-07-06 00:00:00.000",
        },
      ],
      totalErrors: 42,
      distinctClusters: 1,
      truncated: false,
      window: { sinceHours: 24 },
    });
    expect(out.clusters[0]?.fingerprint).toBe("fp1");
    expect(out.totalErrors).toBe(42);
    expect(out.window.sinceHours).toBe(24);
  });
});
