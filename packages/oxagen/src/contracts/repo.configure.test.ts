import { describe, expect, it } from "vitest";
import { repoConfigure } from "./repo.configure";
import { getCapability } from "../registry";

describe("repo.configure capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("accepts minimal input with only repoId", () => {
    const parsed = repoConfigure.input.parse({ repoId: "conn_abc123" });
    expect(parsed.repoId).toBe("conn_abc123");
  });

  it("rejects input missing repoId", () => {
    expect(() => repoConfigure.input.parse({})).toThrow();
  });

  it("rejects non-string repoId", () => {
    expect(() => repoConfigure.input.parse({ repoId: 42 })).toThrow();
  });

  // ── input: optional fields default to undefined ───────────────────────────

  it("recordTypes is undefined when omitted", () => {
    const parsed = repoConfigure.input.parse({ repoId: "r1" });
    expect(parsed.recordTypes).toBeUndefined();
  });

  // ── input: recordTypes ────────────────────────────────────────────────────

  it("accepts a non-empty recordTypes array", () => {
    const parsed = repoConfigure.input.parse({
      repoId: "r1",
      recordTypes: ["pull_request", "issue", "commit"],
    });
    expect(parsed.recordTypes).toEqual(["pull_request", "issue", "commit"]);
  });

  it("rejects recordTypes containing non-string element", () => {
    expect(() =>
      repoConfigure.input.parse({ repoId: "r1", recordTypes: [42] }),
    ).toThrow();
  });

  // ── input: syncCadence enum ───────────────────────────────────────────────

  it("accepts syncCadence='manual'", () => {
    const parsed = repoConfigure.input.parse({
      repoId: "r1",
      syncCadence: "manual",
    });
    expect(parsed.syncCadence).toBe("manual");
  });

  it("accepts syncCadence='polling'", () => {
    const parsed = repoConfigure.input.parse({
      repoId: "r1",
      syncCadence: "polling",
    });
    expect(parsed.syncCadence).toBe("polling");
  });

  it("accepts syncCadence='webhook'", () => {
    const parsed = repoConfigure.input.parse({
      repoId: "r1",
      syncCadence: "webhook",
    });
    expect(parsed.syncCadence).toBe("webhook");
  });

  it("rejects an unknown syncCadence value", () => {
    expect(() =>
      repoConfigure.input.parse({ repoId: "r1", syncCadence: "realtime" }),
    ).toThrow();
  });

  // ── input: pollingIntervalSeconds ─────────────────────────────────────────

  it("accepts pollingIntervalSeconds=60 (positive integer)", () => {
    const parsed = repoConfigure.input.parse({
      repoId: "r1",
      pollingIntervalSeconds: 60,
    });
    expect(parsed.pollingIntervalSeconds).toBe(60);
  });

  it("rejects pollingIntervalSeconds=0 (not positive)", () => {
    expect(() =>
      repoConfigure.input.parse({ repoId: "r1", pollingIntervalSeconds: 0 }),
    ).toThrow();
  });

  it("rejects pollingIntervalSeconds=-1 (negative)", () => {
    expect(() =>
      repoConfigure.input.parse({ repoId: "r1", pollingIntervalSeconds: -1 }),
    ).toThrow();
  });

  it("rejects a non-integer pollingIntervalSeconds", () => {
    expect(() =>
      repoConfigure.input.parse({ repoId: "r1", pollingIntervalSeconds: 30.5 }),
    ).toThrow();
  });

  // ── input: pathFilters ────────────────────────────────────────────────────

  it("accepts pathFilters with include and exclude arrays", () => {
    const parsed = repoConfigure.input.parse({
      repoId: "r1",
      pathFilters: { include: ["src/**"], exclude: ["node_modules/**"] },
    });
    expect(parsed.pathFilters?.include).toEqual(["src/**"]);
    expect(parsed.pathFilters?.exclude).toEqual(["node_modules/**"]);
  });

  it("accepts pathFilters with both sub-fields omitted", () => {
    const parsed = repoConfigure.input.parse({ repoId: "r1", pathFilters: {} });
    expect(parsed.pathFilters).toBeDefined();
    expect(parsed.pathFilters?.include).toBeUndefined();
  });

  // ── input: labelFilters ───────────────────────────────────────────────────

  it("accepts labelFilters with include and exclude arrays", () => {
    const parsed = repoConfigure.input.parse({
      repoId: "r1",
      labelFilters: { include: ["bug"], exclude: ["wontfix"] },
    });
    expect(parsed.labelFilters?.include).toEqual(["bug"]);
    expect(parsed.labelFilters?.exclude).toEqual(["wontfix"]);
  });

  // ── input: fieldMappings ──────────────────────────────────────────────────

  it("accepts a fieldMappings record", () => {
    const parsed = repoConfigure.input.parse({
      repoId: "r1",
      fieldMappings: { "pr.title": "name", "pr.body": "description" },
    });
    expect(parsed.fieldMappings?.["pr.title"]).toBe("name");
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a full valid output", () => {
    const parsed = repoConfigure.output.parse({
      repoId: "conn_abc123",
      displayName: "my-org/my-repo",
      recordTypes: ["pull_request", "issue"],
      pathFilters: { include: ["src/**"], exclude: ["dist/**"] },
      labelFilters: { include: ["bug"], exclude: [] },
      syncCadence: "webhook",
      pollingIntervalSeconds: null,
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    expect(parsed.repoId).toBe("conn_abc123");
    expect(parsed.displayName).toBe("my-org/my-repo");
    expect(parsed.syncCadence).toBe("webhook");
    expect(parsed.pollingIntervalSeconds).toBeNull();
  });

  it("parses output with null pathFilters and labelFilters", () => {
    const parsed = repoConfigure.output.parse({
      repoId: "r1",
      displayName: "my-repo",
      recordTypes: [],
      pathFilters: null,
      labelFilters: null,
      syncCadence: "manual",
      pollingIntervalSeconds: null,
      updatedAt: "2024-06-01T12:00:00.000Z",
    });
    expect(parsed.pathFilters).toBeNull();
    expect(parsed.labelFilters).toBeNull();
  });

  it("parses output with a positive pollingIntervalSeconds", () => {
    const parsed = repoConfigure.output.parse({
      repoId: "r1",
      displayName: "my-repo",
      recordTypes: ["commit"],
      pathFilters: null,
      labelFilters: null,
      syncCadence: "polling",
      pollingIntervalSeconds: 3600,
      updatedAt: "2024-06-01T12:00:00.000Z",
    });
    expect(parsed.pollingIntervalSeconds).toBe(3600);
  });

  it("rejects output missing displayName", () => {
    expect(() =>
      repoConfigure.output.parse({
        repoId: "r1",
        recordTypes: [],
        pathFilters: null,
        labelFilters: null,
        syncCadence: "manual",
        pollingIntervalSeconds: null,
        updatedAt: "2024-06-01T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output with invalid syncCadence", () => {
    expect(() =>
      repoConfigure.output.parse({
        repoId: "r1",
        displayName: "repo",
        recordTypes: [],
        pathFilters: null,
        labelFilters: null,
        syncCadence: "cron",
        pollingIntervalSeconds: null,
        updatedAt: "2024-06-01T12:00:00.000Z",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("configure_repo")).toBe(repoConfigure);
  });
});
