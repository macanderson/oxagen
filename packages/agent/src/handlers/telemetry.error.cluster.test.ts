import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@oxagen/telemetry", () => ({ clusterErrorEvents: vi.fn() }));

import { clusterErrorEvents } from "@oxagen/telemetry";
import { telemetryErrorClusterHandler } from "./telemetry.error.cluster";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const clusterMock = vi.mocked(clusterErrorEvents);

beforeEach(() => {
  vi.clearAllMocks();
  clusterMock.mockResolvedValue({
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
  });
});

describe("telemetryErrorClusterHandler", () => {
  it("defaults to a 24h window and passes it through to clusterErrorEvents", async () => {
    const before = Date.now();
    await telemetryErrorClusterHandler({}, CTX);
    const call = clusterMock.mock.calls[0]?.[0];
    expect(call?.orgId).toBe(CTX.orgId);
    expect(call?.sinceMs).toBeLessThanOrEqual(before - 24 * 60 * 60 * 1000 + 5);
    expect(call?.sinceMs).toBeGreaterThan(before - 24 * 60 * 60 * 1000 - 5000);
  });

  it("passes severity/source/limit through unmodified", async () => {
    await telemetryErrorClusterHandler(
      { sinceHours: 48, severity: "fatal", source: "mcp", limit: 5 },
      CTX,
    );
    const call = clusterMock.mock.calls[0]?.[0];
    expect(call?.severity).toBe("fatal");
    expect(call?.source).toBe("mcp");
    expect(call?.limit).toBe(5);
  });

  it("returns typed clusters, totals, and the effective window", async () => {
    const out = await telemetryErrorClusterHandler({ sinceHours: 12 }, CTX);
    expect(out.clusters).toHaveLength(1);
    expect(out.clusters[0]).toMatchObject({
      fingerprint: "fp1",
      errorClass: "TypeError",
      count: 42,
    });
    expect(out.totalErrors).toBe(42);
    expect(out.distinctClusters).toBe(1);
    expect(out.window).toEqual({ sinceHours: 12 });
    expect(out.truncated).toBe(false);
  });

  it("flags truncated when distinctClusters exceeds the returned page", async () => {
    clusterMock.mockResolvedValue({
      clusters: [
        {
          fingerprint: "fp1",
          errorClass: "TypeError",
          sampleMessage: "boom",
          severity: "error",
          source: "api",
          count: 10,
          firstSeen: "2026-07-05 00:00:00.000",
          lastSeen: "2026-07-06 00:00:00.000",
        },
      ],
      totalErrors: 100,
      distinctClusters: 20,
    });
    const out = await telemetryErrorClusterHandler({ limit: 1 }, CTX);
    expect(out.truncated).toBe(true);
  });

  it("clamps an oversized sample message", async () => {
    clusterMock.mockResolvedValue({
      clusters: [
        {
          fingerprint: "fp1",
          errorClass: "Error",
          sampleMessage: "x".repeat(1000),
          severity: "warn",
          source: "app",
          count: 1,
          firstSeen: "2026-07-06 00:00:00.000",
          lastSeen: "2026-07-06 00:00:00.000",
        },
      ],
      totalErrors: 1,
      distinctClusters: 1,
    });
    const out = await telemetryErrorClusterHandler({}, CTX);
    expect(out.clusters[0]!.sampleMessage.length).toBeLessThanOrEqual(620);
    expect(out.clusters[0]!.sampleMessage.endsWith("[truncated]")).toBe(true);
  });
});
