import { describe, expect, it } from "vitest";
import { repoPause } from "./repo.pause";
import { getCapability } from "../registry";

describe("repo.pause capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("accepts a valid repoId", () => {
    const parsed = repoPause.input.parse({ repoId: "conn_pause_01" });
    expect(parsed.repoId).toBe("conn_pause_01");
  });

  it("rejects input missing repoId", () => {
    expect(() => repoPause.input.parse({})).toThrow();
  });

  it("rejects non-string repoId", () => {
    expect(() => repoPause.input.parse({ repoId: true })).toThrow();
  });

  it("rejects null repoId", () => {
    expect(() => repoPause.input.parse({ repoId: null })).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a full valid output", () => {
    const parsed = repoPause.output.parse({
      repoId: "conn_pause_01",
      status: "paused",
      pausedAt: "2024-06-01T12:00:00.000Z",
    });
    expect(parsed.repoId).toBe("conn_pause_01");
    expect(parsed.status).toBe("paused");
    expect(parsed.pausedAt).toBe("2024-06-01T12:00:00.000Z");
  });

  it("rejects output with status other than 'paused'", () => {
    expect(() =>
      repoPause.output.parse({
        repoId: "conn_pause_01",
        status: "active",
        pausedAt: "2024-06-01T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing pausedAt", () => {
    expect(() =>
      repoPause.output.parse({
        repoId: "conn_pause_01",
        status: "paused",
      }),
    ).toThrow();
  });

  it("rejects output missing repoId", () => {
    expect(() =>
      repoPause.output.parse({
        status: "paused",
        pausedAt: "2024-06-01T12:00:00.000Z",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("pause_repo")).toBe(repoPause);
  });
});
