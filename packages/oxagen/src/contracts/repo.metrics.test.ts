import { describe, expect, it } from "vitest";
import { repoMetrics } from "./repo.metrics";
import { getCapability } from "../registry";

describe("repo.metrics capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("accepts a valid repoId", () => {
    const parsed = repoMetrics.input.parse({ repoId: "conn_xyz" });
    expect(parsed.repoId).toBe("conn_xyz");
  });

  it("rejects input missing repoId", () => {
    expect(() => repoMetrics.input.parse({})).toThrow();
  });

  it("rejects non-string repoId", () => {
    expect(() => repoMetrics.input.parse({ repoId: 99 })).toThrow();
  });

  // ── output: status enum ───────────────────────────────────────────────────

  it("parses a full valid output with status='active'", () => {
    const parsed = repoMetrics.output.parse({
      repoId: "conn_xyz",
      displayName: "my-org/my-repo",
      status: "active",
      entityCount: 1500,
      entityCountByType: { pull_request: 200, issue: 1300 },
      lastSyncAt: "2024-06-01T10:00:00.000Z",
      lastSyncDurationMs: 4200,
      lastErrorAt: null,
      errorMessage: null,
      syncIntervalSeconds: 3600,
      estimatedNextSyncAt: "2024-06-01T11:00:00.000Z",
    });
    expect(parsed.repoId).toBe("conn_xyz");
    expect(parsed.status).toBe("active");
    expect(parsed.entityCount).toBe(1500);
    expect(parsed.entityCountByType["pull_request"]).toBe(200);
    expect(parsed.lastSyncDurationMs).toBe(4200);
    expect(parsed.syncIntervalSeconds).toBe(3600);
  });

  it("accepts status='pending_setup'", () => {
    const parsed = repoMetrics.output.parse({
      repoId: "r1",
      displayName: "repo",
      status: "pending_setup",
      entityCount: 0,
      entityCountByType: {},
      lastSyncAt: null,
      lastSyncDurationMs: null,
      lastErrorAt: null,
      errorMessage: null,
      syncIntervalSeconds: null,
      estimatedNextSyncAt: null,
    });
    expect(parsed.status).toBe("pending_setup");
  });

  it("accepts status='paused'", () => {
    const parsed = repoMetrics.output.parse({
      repoId: "r1",
      displayName: "repo",
      status: "paused",
      entityCount: 10,
      entityCountByType: { commit: 10 },
      lastSyncAt: null,
      lastSyncDurationMs: null,
      lastErrorAt: null,
      errorMessage: null,
      syncIntervalSeconds: null,
      estimatedNextSyncAt: null,
    });
    expect(parsed.status).toBe("paused");
  });

  it("accepts status='failed'", () => {
    const parsed = repoMetrics.output.parse({
      repoId: "r1",
      displayName: "repo",
      status: "failed",
      entityCount: 0,
      entityCountByType: {},
      lastSyncAt: null,
      lastSyncDurationMs: null,
      lastErrorAt: "2024-06-01T09:00:00.000Z",
      errorMessage: "Connection refused",
      syncIntervalSeconds: null,
      estimatedNextSyncAt: null,
    });
    expect(parsed.status).toBe("failed");
    expect(parsed.errorMessage).toBe("Connection refused");
    expect(parsed.lastErrorAt).toBe("2024-06-01T09:00:00.000Z");
  });

  it("rejects an unknown status value", () => {
    expect(() =>
      repoMetrics.output.parse({
        repoId: "r1",
        displayName: "repo",
        status: "syncing",
        entityCount: 0,
        entityCountByType: {},
        lastSyncAt: null,
        lastSyncDurationMs: null,
        lastErrorAt: null,
        errorMessage: null,
        syncIntervalSeconds: null,
        estimatedNextSyncAt: null,
      }),
    ).toThrow();
  });

  // ── output: nullable fields ───────────────────────────────────────────────

  it("parses output with all nullable fields set to null", () => {
    const parsed = repoMetrics.output.parse({
      repoId: "r1",
      displayName: "repo",
      status: "active",
      entityCount: 0,
      entityCountByType: {},
      lastSyncAt: null,
      lastSyncDurationMs: null,
      lastErrorAt: null,
      errorMessage: null,
      syncIntervalSeconds: null,
      estimatedNextSyncAt: null,
    });
    expect(parsed.lastSyncAt).toBeNull();
    expect(parsed.lastSyncDurationMs).toBeNull();
    expect(parsed.lastErrorAt).toBeNull();
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.syncIntervalSeconds).toBeNull();
    expect(parsed.estimatedNextSyncAt).toBeNull();
  });

  it("rejects output missing entityCount", () => {
    expect(() =>
      repoMetrics.output.parse({
        repoId: "r1",
        displayName: "repo",
        status: "active",
        entityCountByType: {},
        lastSyncAt: null,
        lastSyncDurationMs: null,
        lastErrorAt: null,
        errorMessage: null,
        syncIntervalSeconds: null,
        estimatedNextSyncAt: null,
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("get_repo_metrics")).toBe(repoMetrics);
  });
});
