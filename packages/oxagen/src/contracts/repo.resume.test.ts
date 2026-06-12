import { describe, expect, it } from "vitest";
import { repoResume } from "./repo.resume";
import { getCapability } from "../registry";

describe("repo.resume capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("accepts a valid repoId", () => {
    const parsed = repoResume.input.parse({ repoId: "conn_resume_01" });
    expect(parsed.repoId).toBe("conn_resume_01");
  });

  it("rejects input missing repoId", () => {
    expect(() => repoResume.input.parse({})).toThrow();
  });

  it("rejects non-string repoId", () => {
    expect(() => repoResume.input.parse({ repoId: 123 })).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a full valid output with non-null nextSyncAt", () => {
    const parsed = repoResume.output.parse({
      repoId: "conn_resume_01",
      status: "active",
      resumedAt: "2024-06-01T14:00:00.000Z",
      nextSyncAt: "2024-06-01T15:00:00.000Z",
    });
    expect(parsed.repoId).toBe("conn_resume_01");
    expect(parsed.status).toBe("active");
    expect(parsed.resumedAt).toBe("2024-06-01T14:00:00.000Z");
    expect(parsed.nextSyncAt).toBe("2024-06-01T15:00:00.000Z");
  });

  it("parses a valid output with null nextSyncAt", () => {
    const parsed = repoResume.output.parse({
      repoId: "conn_resume_01",
      status: "active",
      resumedAt: "2024-06-01T14:00:00.000Z",
      nextSyncAt: null,
    });
    expect(parsed.nextSyncAt).toBeNull();
  });

  it("rejects output with status other than 'active'", () => {
    expect(() =>
      repoResume.output.parse({
        repoId: "conn_resume_01",
        status: "paused",
        resumedAt: "2024-06-01T14:00:00.000Z",
        nextSyncAt: null,
      }),
    ).toThrow();
  });

  it("rejects output missing resumedAt", () => {
    expect(() =>
      repoResume.output.parse({
        repoId: "conn_resume_01",
        status: "active",
        nextSyncAt: null,
      }),
    ).toThrow();
  });

  it("rejects output missing nextSyncAt (not optional, just nullable)", () => {
    expect(() =>
      repoResume.output.parse({
        repoId: "conn_resume_01",
        status: "active",
        resumedAt: "2024-06-01T14:00:00.000Z",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("repo.resume")).toBe(repoResume);
  });
});
