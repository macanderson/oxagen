import { describe, expect, it } from "vitest";
import { integrationSync } from "./integration.sync";
import { getCapability } from "../registry";

describe("integration.sync capability", () => {
  // ── input: required field ─────────────────────────────────────────────────

  it("accepts a minimal input with only integrationId", () => {
    const parsed = integrationSync.input.parse({ integrationId: "inst_abc" });
    expect(parsed.integrationId).toBe("inst_abc");
  });

  it("rejects input missing integrationId", () => {
    expect(() => integrationSync.input.parse({})).toThrow();
  });

  it("rejects integrationId of wrong type", () => {
    expect(() => integrationSync.input.parse({ integrationId: 42 })).toThrow();
  });

  // ── input: mode default ───────────────────────────────────────────────────

  it("defaults mode to 'incremental'", () => {
    const parsed = integrationSync.input.parse({ integrationId: "inst_abc" });
    expect(parsed.mode).toBe("incremental");
  });

  // ── input: mode enum ──────────────────────────────────────────────────────

  it("accepts mode='incremental'", () => {
    const parsed = integrationSync.input.parse({
      integrationId: "inst_abc",
      mode: "incremental",
    });
    expect(parsed.mode).toBe("incremental");
  });

  it("accepts mode='full'", () => {
    const parsed = integrationSync.input.parse({
      integrationId: "inst_abc",
      mode: "full",
    });
    expect(parsed.mode).toBe("full");
  });

  it("rejects an unknown mode value", () => {
    expect(() =>
      integrationSync.input.parse({
        integrationId: "inst_abc",
        mode: "partial",
      }),
    ).toThrow();
  });

  // ── output: valid full parse ──────────────────────────────────────────────

  it("parses a valid full output with mode='incremental'", () => {
    const parsed = integrationSync.output.parse({
      jobId: "job_sync_001",
      status: "queued",
      integrationId: "inst_abc",
      mode: "incremental",
    });
    expect(parsed.jobId).toBe("job_sync_001");
    expect(parsed.status).toBe("queued");
    expect(parsed.integrationId).toBe("inst_abc");
    expect(parsed.mode).toBe("incremental");
  });

  it("parses a valid output with mode='full'", () => {
    const parsed = integrationSync.output.parse({
      jobId: "job_sync_002",
      status: "queued",
      integrationId: "inst_abc",
      mode: "full",
    });
    expect(parsed.mode).toBe("full");
  });

  it("rejects output with wrong status literal", () => {
    expect(() =>
      integrationSync.output.parse({
        jobId: "job_sync_001",
        status: "running",
        integrationId: "inst_abc",
        mode: "incremental",
      }),
    ).toThrow();
  });

  it("rejects output with unknown mode value", () => {
    expect(() =>
      integrationSync.output.parse({
        jobId: "job_sync_001",
        status: "queued",
        integrationId: "inst_abc",
        mode: "delta",
      }),
    ).toThrow();
  });

  it("rejects output missing jobId", () => {
    expect(() =>
      integrationSync.output.parse({
        status: "queued",
        integrationId: "inst_abc",
        mode: "incremental",
      }),
    ).toThrow();
  });

  it("rejects output missing integrationId", () => {
    expect(() =>
      integrationSync.output.parse({
        jobId: "job_sync_001",
        status: "queued",
        mode: "incremental",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("sync_integration")).toBe(integrationSync);
  });
});
