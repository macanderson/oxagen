import { describe, expect, it } from "vitest";
import { videoGenerate } from "./video.generate";

describe("video.generate capability", () => {
  // ── input validation ────────────────────────────────────────────────────────

  it("parses a minimal valid input (prompt only)", () => {
    const parsed = videoGenerate.input.parse({
      prompt: "A sunset over the ocean",
    });
    expect(parsed.prompt).toBe("A sunset over the ocean");
    expect(parsed.durationSeconds).toBeUndefined();
    expect(parsed.aspectRatio).toBeUndefined();
    expect(parsed.style).toBeUndefined();
  });

  it("parses a fully-populated input", () => {
    const parsed = videoGenerate.input.parse({
      prompt: "A timelapse of city lights",
      durationSeconds: 15,
      aspectRatio: "16:9",
      style: "cinematic",
    });
    expect(parsed.durationSeconds).toBe(15);
    expect(parsed.aspectRatio).toBe("16:9");
    expect(parsed.style).toBe("cinematic");
  });

  it("accepts all valid aspect ratios", () => {
    for (const ar of ["16:9", "9:16", "1:1"] as const) {
      const parsed = videoGenerate.input.parse({
        prompt: "test",
        aspectRatio: ar,
      });
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

  it("accepts an explicit gateway model id", () => {
    const parsed = videoGenerate.input.parse({
      prompt: "test",
      model: "openai/sora-2",
    });
    expect(parsed.model).toBe("openai/sora-2");
  });

  it("rejects an empty model id", () => {
    expect(() =>
      videoGenerate.input.parse({ prompt: "test", model: "" }),
    ).toThrow();
  });

  // ── output validation ───────────────────────────────────────────────────────

  it("parses a valid queued output", () => {
    const parsed = videoGenerate.output.parse({
      status: "queued",
      jobId: "gen_abc123",
      serveUrl: "/api/v1/assets/gen_abc123",
      render: {
        componentId: "video-result",
        props: { url: "/api/v1/assets/gen_abc123", prompt: "A sunset" },
      },
    });
    expect(parsed.status).toBe("queued");
    expect(parsed.jobId).toBe("gen_abc123");
    expect(parsed.serveUrl).toBe("/api/v1/assets/gen_abc123");
    expect(parsed.render.componentId).toBe("video-result");
  });

  it("parses a valid output with full render props", () => {
    const parsed = videoGenerate.output.parse({
      status: "queued",
      jobId: "gen_xyz",
      serveUrl: "/api/v1/assets/gen_xyz",
      render: {
        componentId: "video-result",
        props: { url: "/api/v1/assets/gen_xyz", prompt: "ocean waves" },
      },
    });
    expect(parsed.render.props.prompt).toBe("ocean waves");
    expect(parsed.render.props.url).toBe("/api/v1/assets/gen_xyz");
  });

  it("parses an output carrying a duration adjustment and notice", () => {
    const parsed = videoGenerate.output.parse({
      status: "queued",
      jobId: "gen_dur",
      serveUrl: "/api/v1/assets/gen_dur",
      durationAdjustment: {
        requestedSeconds: 30,
        effectiveSeconds: 8,
        supportedSeconds: [4, 6, 8],
        alternatives: [
          {
            model: "openai/sora-2",
            supportedSeconds: [4, 8, 12],
            closestSeconds: 12,
          },
        ],
      },
      render: {
        componentId: "video-result",
        props: {
          url: "/api/v1/assets/gen_dur",
          prompt: "epic",
          notice:
            "google/veo supports 4, 6, 8 second videos — generating 8s instead of the requested 30s.",
        },
      },
    });
    expect(parsed.durationAdjustment?.effectiveSeconds).toBe(8);
    expect(parsed.durationAdjustment?.alternatives[0]?.model).toBe(
      "openai/sora-2",
    );
    expect(parsed.render.props.notice).toContain("generating 8s");
  });

  it("rejects output where render.componentId is not video-result", () => {
    expect(() =>
      videoGenerate.output.parse({
        status: "queued",
        jobId: "gen_abc",
        serveUrl: "/api/v1/assets/gen_abc",
        render: {
          componentId: "svg-preview",
          props: { url: "/u", prompt: "p" },
        },
      }),
    ).toThrow();
  });

  it("rejects output missing required jobId", () => {
    expect(() =>
      videoGenerate.output.parse({
        status: "queued",
        serveUrl: "/api/v1/assets/gen_abc",
        render: {
          componentId: "video-result",
          props: { url: "/u", prompt: "p" },
        },
      }),
    ).toThrow();
  });

  it("rejects output missing required serveUrl", () => {
    expect(() =>
      videoGenerate.output.parse({
        status: "queued",
        jobId: "gen_abc",
        render: {
          componentId: "video-result",
          props: { url: "/u", prompt: "p" },
        },
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
