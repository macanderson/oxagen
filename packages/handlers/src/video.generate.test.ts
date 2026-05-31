import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { videoGenerateHandler } from "./video.generate.js";
import type { CapabilityContext } from "@oxagen/oxagen";

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

describe("videoGenerateHandler", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── stub shape ──────────────────────────────────────────────────────────────

  it("returns stub: true and status: queued without throwing", async () => {
    const result = await videoGenerateHandler({ prompt: "Ocean waves" }, CTX);

    expect(result.stub).toBe(true);
    expect(result.status).toBe("queued");
  });

  it("returns a non-empty jobId prefixed with 'stub_'", async () => {
    const result = await videoGenerateHandler({ prompt: "Sunset" }, CTX);
    expect(result.jobId).toMatch(/^stub_/);
  });

  it("returns a render directive with componentId 'make-video-form'", async () => {
    const result = await videoGenerateHandler({ prompt: "City timelapse" }, CTX);
    expect(result.render.componentId).toBe("make-video-form");
  });

  // ── render props echo ───────────────────────────────────────────────────────

  it("echoes prompt into render props", async () => {
    const result = await videoGenerateHandler({ prompt: "Flying drones" }, CTX);
    expect(result.render.props.prompt).toBe("Flying drones");
  });

  it("echoes optional fields into render props when provided", async () => {
    const result = await videoGenerateHandler(
      { prompt: "Forest", durationSeconds: 20, aspectRatio: "9:16", style: "lo-fi" },
      CTX,
    );
    expect(result.render.props.durationSeconds).toBe(20);
    expect(result.render.props.aspectRatio).toBe("9:16");
    expect(result.render.props.style).toBe("lo-fi");
  });

  it("omits optional fields from render props when absent", async () => {
    const result = await videoGenerateHandler({ prompt: "Stars" }, CTX);
    expect(result.render.props.durationSeconds).toBeUndefined();
    expect(result.render.props.aspectRatio).toBeUndefined();
    expect(result.render.props.style).toBeUndefined();
  });

  // ── uniqueness ──────────────────────────────────────────────────────────────

  it("returns a unique jobId on each call", async () => {
    const a = await videoGenerateHandler({ prompt: "A" }, CTX);
    const b = await videoGenerateHandler({ prompt: "B" }, CTX);
    expect(a.jobId).not.toBe(b.jobId);
  });

  // ── logging ─────────────────────────────────────────────────────────────────

  it("logs the stub intent with the prompt", async () => {
    const spy = vi.spyOn(console, "log");
    await videoGenerateHandler({ prompt: "A volcano erupting" }, CTX);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[stub] video.generate"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("A volcano erupting"));
  });

  it("includes duration in the log when provided", async () => {
    const spy = vi.spyOn(console, "log");
    await videoGenerateHandler({ prompt: "Waves", durationSeconds: 30 }, CTX);
    const calls = spy.mock.calls.flat().join("\n");
    expect(calls).toContain("30s");
  });

  it("includes aspect ratio in the log when provided", async () => {
    const spy = vi.spyOn(console, "log");
    await videoGenerateHandler({ prompt: "Waves", aspectRatio: "1:1" }, CTX);
    const calls = spy.mock.calls.flat().join("\n");
    expect(calls).toContain("1:1");
  });

  it("includes style in the log when provided", async () => {
    const spy = vi.spyOn(console, "log");
    await videoGenerateHandler({ prompt: "Waves", style: "cinematic" }, CTX);
    const calls = spy.mock.calls.flat().join("\n");
    expect(calls).toContain("cinematic");
  });

  it("includes brandKitId in the log when provided", async () => {
    const spy = vi.spyOn(console, "log");
    await videoGenerateHandler({ prompt: "Waves", brandKitId: "bk_xyz" }, CTX);
    const calls = spy.mock.calls.flat().join("\n");
    expect(calls).toContain("bk_xyz");
  });

  // ── never throws ────────────────────────────────────────────────────────────

  it("never throws with minimal input", async () => {
    await expect(videoGenerateHandler({ prompt: "T" }, CTX)).resolves.not.toThrow();
  });

  it("never throws with fully-populated input", async () => {
    await expect(
      videoGenerateHandler(
        { prompt: "Full", durationSeconds: 60, aspectRatio: "16:9", style: "anime", brandKitId: "bk_1" },
        CTX,
      ),
    ).resolves.not.toThrow();
  });
});
