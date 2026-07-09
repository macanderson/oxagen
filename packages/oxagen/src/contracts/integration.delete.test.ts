import { describe, expect, it } from "vitest";
import { integrationDelete } from "./integration.delete";
import { getCapability } from "../registry";

describe("integration.delete capability", () => {
  // ── input: required field ─────────────────────────────────────────────────

  it("accepts a minimal input with only integrationId", () => {
    const parsed = integrationDelete.input.parse({ integrationId: "inst_xyz" });
    expect(parsed.integrationId).toBe("inst_xyz");
  });

  it("rejects input missing integrationId", () => {
    expect(() => integrationDelete.input.parse({})).toThrow();
  });

  it("rejects integrationId of wrong type", () => {
    expect(() =>
      integrationDelete.input.parse({ integrationId: 99 }),
    ).toThrow();
  });

  // ── input: purgeData default ──────────────────────────────────────────────

  it("defaults purgeData to false", () => {
    const parsed = integrationDelete.input.parse({ integrationId: "inst_xyz" });
    expect(parsed.purgeData).toBe(false);
  });

  it("accepts purgeData=true", () => {
    const parsed = integrationDelete.input.parse({
      integrationId: "inst_xyz",
      purgeData: true,
    });
    expect(parsed.purgeData).toBe(true);
  });

  it("accepts purgeData=false explicitly", () => {
    const parsed = integrationDelete.input.parse({
      integrationId: "inst_xyz",
      purgeData: false,
    });
    expect(parsed.purgeData).toBe(false);
  });

  it("rejects purgeData of wrong type", () => {
    expect(() =>
      integrationDelete.input.parse({
        integrationId: "inst_xyz",
        purgeData: "yes",
      }),
    ).toThrow();
  });

  // ── output: valid full parse ──────────────────────────────────────────────

  it("parses a valid full output", () => {
    const parsed = integrationDelete.output.parse({
      jobId: "job_del_001",
      status: "queued",
      integrationId: "inst_xyz",
      purgeData: true,
    });
    expect(parsed.jobId).toBe("job_del_001");
    expect(parsed.status).toBe("queued");
    expect(parsed.integrationId).toBe("inst_xyz");
    expect(parsed.purgeData).toBe(true);
  });

  it("parses output with purgeData=false", () => {
    const parsed = integrationDelete.output.parse({
      jobId: "job_del_002",
      status: "queued",
      integrationId: "inst_xyz",
      purgeData: false,
    });
    expect(parsed.purgeData).toBe(false);
  });

  it("rejects output with wrong status literal", () => {
    expect(() =>
      integrationDelete.output.parse({
        jobId: "job_del_001",
        status: "running",
        integrationId: "inst_xyz",
        purgeData: false,
      }),
    ).toThrow();
  });

  it("rejects output missing jobId", () => {
    expect(() =>
      integrationDelete.output.parse({
        status: "queued",
        integrationId: "inst_xyz",
        purgeData: false,
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("delete_integration")).toBe(integrationDelete);
  });
});
