import { describe, expect, it } from "vitest";
import { videoGenerate } from "./video.generate.js";

describe("video.generate capability", () => {
  // ── input validation ────────────────────────────────────────────────────────

  it("parses a minimal valid input (prompt only)", () => {
    const parsed = videoGenerate.input.parse({ prompt: "A sunset over the ocean" });
    expect(parsed.prompt).toBe("A sunset over the ocean");
    expect(parsed.durationSeconds).toBeUndefined();
    expect(parsed.aspectRatio).toBeUndefined();
    expect(parsed.style).toBeUndefined();
    expect(parsed.brandKitId).toBeUndefined();
  });

  it("parses a fully-populated input", () => {
    const parsed = videoGenerate.input.parse({
      prompt: "A timelapse of city lights",
      durationSeconds: 15,
      aspectRatio: "16:9",
      style: "cinematic",
      brandKitId: "bk_abc123",
    });
    expect(parsed.durationSeconds).toBe(15);
    expect(parsed.aspectRatio).toBe("16:9");
    expect(parsed.style).toBe("cinematic");
    expect(parsed.brandKitId).toBe("bk_abc123");
  });

  it("accepts all valid aspect ratios", () => {
    for (const ar of ["16:9", "9:16", "1:1"] as const) {
      const parsed = videoGenerate.input.parse({ prompt: "test", aspectRatio: ar });
      expect(parsed.aspectRatio).toBe(ar);
    }
  });

  it("rejects an empty prompt", () => {
    expect(() => videoGenerate.input.parse({ prompt: "" })).toThrow();
  });

  it("rejects a missing prompt", () => {
    expect(() => videoGenerate.input.parse({})).toThrow();
  });

  it("rejects an invalid aspect ratio", () => {
    expect(() =>
      videoGenerate.input.parse({ prompt: "test", aspectRatio: "4:3" }),
    ).toThrow();
  });

  it("rejects durationSeconds below 1", () => {
    expect(() =>
      videoGenerate.input.parse({ prompt: "test", durationSeconds: 0 }),
    ).toThrow();
  });

  it("rejects durationSeconds above 60", () => {
    expect(() =>
      videoGenerate.input.parse({ prompt: "test", durationSeconds: 61 }),
    ).toThrow();
  });

  // ── output validation ───────────────────────────────────────────────────────

  it("parses a valid stub output", () => {
    const parsed = videoGenerate.output.parse({
      stub: true,
      status: "queued",
      jobId: "job_abc123",
      render: {
        componentId: "make-video-form",
        props: { prompt: "test" },
      },
    });
    expect(parsed.stub).toBe(true);
    expect(parsed.status).toBe("queued");
    expect(parsed.jobId).toBe("job_abc123");
    expect(parsed.render.componentId).toBe("make-video-form");
  });

  it("parses a valid stub output with fully populated render props", () => {
    const parsed = videoGenerate.output.parse({
      stub: true,
      status: "queued",
      jobId: "job_xyz",
      render: {
        componentId: "make-video-form",
        props: { prompt: "ocean", durationSeconds: 10, aspectRatio: "9:16", style: "lo-fi" },
      },
    });
    expect(parsed.render.props.prompt).toBe("ocean");
    expect(parsed.render.props.durationSeconds).toBe(10);
  });

  it("rejects output where render.componentId is not make-video-form", () => {
    expect(() =>
      videoGenerate.output.parse({
        stub: true,
        status: "queued",
        jobId: "job_abc",
        render: { componentId: "svg-preview", props: {} },
      }),
    ).toThrow();
  });

  it("rejects output where stub is false", () => {
    expect(() =>
      videoGenerate.output.parse({
        stub: false,
        status: "queued",
        jobId: "job_abc",
        render: { componentId: "make-video-form", props: {} },
      }),
    ).toThrow();
  });

  // ── capability metadata ─────────────────────────────────────────────────────

  it("declares api, mcp, and agent surfaces", () => {
    expect(videoGenerate.surfaces).toContain("api");
    expect(videoGenerate.surfaces).toContain("mcp");
    expect(videoGenerate.surfaces).toContain("agent");
  });

  it("is org/workspace scoped", () => {
    expect(videoGenerate.scoped).toBe(true);
  });
});
