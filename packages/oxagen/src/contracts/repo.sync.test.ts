import { describe, expect, it } from "vitest";
import { repoSync } from "./repo.sync";
import { getCapability } from "../registry";

describe("repo.sync capability", () => {
  // ── input: defaults ───────────────────────────────────────────────────────

  it("defaults mode to 'incremental'", () => {
    const parsed = repoSync.input.parse({ repoId: "conn_sync_01" });
    expect(parsed.mode).toBe("incremental");
  });

  it("recordTypes is undefined when omitted", () => {
    const parsed = repoSync.input.parse({ repoId: "conn_sync_01" });
    expect(parsed.recordTypes).toBeUndefined();
  });

  // ── input: required fields ────────────────────────────────────────────────

  it("rejects input missing repoId", () => {
    expect(() => repoSync.input.parse({})).toThrow();
  });

  it("rejects non-string repoId", () => {
    expect(() => repoSync.input.parse({ repoId: [] })).toThrow();
  });

  // ── input: mode enum ──────────────────────────────────────────────────────

  it("accepts mode='incremental'", () => {
    const parsed = repoSync.input.parse({ repoId: "r1", mode: "incremental" });
    expect(parsed.mode).toBe("incremental");
  });

  it("accepts mode='full'", () => {
    const parsed = repoSync.input.parse({ repoId: "r1", mode: "full" });
    expect(parsed.mode).toBe("full");
  });

  it("rejects an unknown mode value", () => {
    expect(() =>
      repoSync.input.parse({ repoId: "r1", mode: "partial" }),
    ).toThrow();
  });

  // ── input: recordTypes ────────────────────────────────────────────────────

  it("accepts a recordTypes array", () => {
    const parsed = repoSync.input.parse({
      repoId: "r1",
      recordTypes: ["pull_request", "commit"],
    });
    expect(parsed.recordTypes).toEqual(["pull_request", "commit"]);
  });

  it("accepts an empty recordTypes array", () => {
    const parsed = repoSync.input.parse({ repoId: "r1", recordTypes: [] });
    expect(parsed.recordTypes).toEqual([]);
  });

  it("rejects recordTypes with a non-string element", () => {
    expect(() =>
      repoSync.input.parse({ repoId: "r1", recordTypes: [123] }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a full valid output with mode='incremental'", () => {
    const parsed = repoSync.output.parse({
      jobId: "job_abc123",
      status: "queued",
      mode: "incremental",
      estimatedRecords: 250,
    });
    expect(parsed.jobId).toBe("job_abc123");
    expect(parsed.status).toBe("queued");
    expect(parsed.mode).toBe("incremental");
    expect(parsed.estimatedRecords).toBe(250);
  });

  it("parses a valid output with mode='full'", () => {
    const parsed = repoSync.output.parse({
      jobId: "job_xyz",
      status: "queued",
      mode: "full",
      estimatedRecords: 10000,
    });
    expect(parsed.mode).toBe("full");
    expect(parsed.estimatedRecords).toBe(10000);
  });

  it("rejects output with status other than 'queued'", () => {
    expect(() =>
      repoSync.output.parse({
        jobId: "job_abc123",
        status: "running",
        mode: "incremental",
        estimatedRecords: 100,
      }),
    ).toThrow();
  });

  it("rejects output missing jobId", () => {
    expect(() =>
      repoSync.output.parse({
        status: "queued",
        mode: "incremental",
        estimatedRecords: 100,
      }),
    ).toThrow();
  });

  it("rejects output with invalid mode", () => {
    expect(() =>
      repoSync.output.parse({
        jobId: "job_abc123",
        status: "queued",
        mode: "delta",
        estimatedRecords: 100,
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("sync_repo")).toBe(repoSync);
  });
});
