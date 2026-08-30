// @vitest-environment jsdom
//
// jsdom does not implement real media decoding or canvas 2D rendering, so
// these tests replace `document.createElement("video"|"canvas")` with fully
// controlled fake elements that implement only the surface
// extract-video-frames.ts touches (EventTarget semantics, currentTime,
// getContext, toBlob). This exercises the real control flow (metadata wait →
// per-frame seek → draw → encode, and every degrade-to-[] branch) without
// depending on jsdom's unimplemented media/canvas backends.

import { describe, it, expect, vi, afterEach } from "vitest";

class FakeMediaElement extends EventTarget {
  preload = "";
  muted = false;
  playsInline = false;
  src = "";
  duration = 0;
  videoWidth = 0;
  videoHeight = 0;
  currentTime = 0;
}

function makeFakeCanvasCtx(): { drawImage: ReturnType<typeof vi.fn> } {
  return { drawImage: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// extract-video-frames.ts only ever calls URL.createObjectURL/revokeObjectURL
// — stub just those two rather than spreading the built-in URL constructor
// (its static methods are non-enumerable, so `{...URL}` silently drops them).
function stubObjectUrl(): void {
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:mock-url"),
    revokeObjectURL: vi.fn(),
  });
}

function videoFile(): File {
  return new File([new Uint8Array(16)], "clip.mp4", { type: "video/mp4" });
}

describe("extractVideoFrames", () => {
  it("returns [] when URL.createObjectURL throws", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => {
        throw new Error("no object URLs here");
      }),
      revokeObjectURL: vi.fn(),
    });
    const { extractVideoFrames } = await import("./extract-video-frames");
    const frames = await extractVideoFrames(videoFile());
    expect(frames).toEqual([]);
  });

  it("returns [] when metadata never loads before the timeout", async () => {
    stubObjectUrl();
    const fakeVideo = new FakeMediaElement();
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") return fakeVideo as unknown as HTMLVideoElement;
      return {} as HTMLElement;
    });
    const { extractVideoFrames } = await import("./extract-video-frames");
    const frames = await extractVideoFrames(videoFile(), {
      metadataTimeoutMs: 10,
    });
    expect(frames).toEqual([]);
  });

  it("returns [] when the video element reports an error before metadata loads", async () => {
    stubObjectUrl();
    const fakeVideo = new FakeMediaElement();
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") return fakeVideo as unknown as HTMLVideoElement;
      return {} as HTMLElement;
    });
    const { extractVideoFrames } = await import("./extract-video-frames");
    const promise = extractVideoFrames(videoFile(), {
      metadataTimeoutMs: 1000,
    });
    fakeVideo.dispatchEvent(new Event("error"));
    expect(await promise).toEqual([]);
  });

  it("returns [] when the loaded video reports a non-finite/zero duration", async () => {
    stubObjectUrl();
    const fakeVideo = new FakeMediaElement();
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") return fakeVideo as unknown as HTMLVideoElement;
      return {} as HTMLElement;
    });
    const { extractVideoFrames } = await import("./extract-video-frames");
    const promise = extractVideoFrames(videoFile());
    fakeVideo.duration = 0;
    fakeVideo.dispatchEvent(new Event("loadedmetadata"));
    expect(await promise).toEqual([]);
  });

  it("returns [] when canvas 2D context is unavailable", async () => {
    stubObjectUrl();
    const fakeVideo = new FakeMediaElement();
    const fakeCanvas = { width: 0, height: 0, getContext: vi.fn(() => null) };
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") return fakeVideo as unknown as HTMLVideoElement;
      if (tag === "canvas") return fakeCanvas as unknown as HTMLCanvasElement;
      return {} as HTMLElement;
    });
    const { extractVideoFrames } = await import("./extract-video-frames");
    const promise = extractVideoFrames(videoFile());
    fakeVideo.duration = 10;
    fakeVideo.dispatchEvent(new Event("loadedmetadata"));
    expect(await promise).toEqual([]);
  });

  it("extracts evenly-spaced frames on the happy path", async () => {
    stubObjectUrl();
    const fakeVideo = new FakeMediaElement();
    const ctx = makeFakeCanvasCtx();
    const blobs = [new Blob(["a"]), new Blob(["b"]), new Blob(["c"])];
    let toBlobCalls = 0;
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
      toBlob: vi.fn((cb: (b: Blob | null) => void) => {
        cb(blobs[toBlobCalls] ?? null);
        toBlobCalls += 1;
      }),
    };
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") return fakeVideo as unknown as HTMLVideoElement;
      if (tag === "canvas") return fakeCanvas as unknown as HTMLCanvasElement;
      return {} as HTMLElement;
    });

    const { extractVideoFrames } = await import("./extract-video-frames");
    const promise = extractVideoFrames(videoFile(), { maxFrames: 3 });

    fakeVideo.duration = 9;
    fakeVideo.videoWidth = 320;
    fakeVideo.videoHeight = 180;
    fakeVideo.dispatchEvent(new Event("loadedmetadata"));

    // Each seek sets currentTime then waits for "seeked" — dispatch it once
    // that specific iteration's seek has actually been requested. Checking
    // only `> 0` is insufficient: it's already true after the first seek, so
    // it would pass immediately on later iterations too and dispatch
    // "seeked" before extract-video-frames.ts has even called seekTo() for
    // that frame — losing the event and stalling on the real (unmocked)
    // seekTimeoutMs setTimeout.
    // Evenly spaced across (0, 9): 9/4, 18/4, 27/4 = 2.25, 4.5, 6.75
    const expectedSeekTimes = [2.25, 4.5, 6.75];
    for (let i = 0; i < 3; i += 1) {
      await vi.waitFor(() => {
        expect(fakeVideo.currentTime).toBeCloseTo(expectedSeekTimes[i]!);
      });
      fakeVideo.dispatchEvent(new Event("seeked"));
    }

    const frames = await promise;
    expect(frames).toHaveLength(3);
    expect(frames.map((f) => f.blob)).toEqual(blobs);
    // Evenly spaced across (0, 9): 9/4, 18/4, 27/4 = 2.25, 4.5, 6.75
    expect(frames[0]!.atSeconds).toBeCloseTo(2.25);
    expect(frames[1]!.atSeconds).toBeCloseTo(4.5);
    expect(frames[2]!.atSeconds).toBeCloseTo(6.75);
    expect(fakeCanvas.width).toBe(320);
    expect(fakeCanvas.height).toBe(180);
    expect(ctx.drawImage).toHaveBeenCalledTimes(3);
  });

  it("skips a frame whose seek times out but still returns the others", async () => {
    stubObjectUrl();
    const fakeVideo = new FakeMediaElement();
    const ctx = makeFakeCanvasCtx();
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
      toBlob: vi.fn((cb: (b: Blob | null) => void) => cb(new Blob(["x"]))),
    };
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") return fakeVideo as unknown as HTMLVideoElement;
      if (tag === "canvas") return fakeCanvas as unknown as HTMLCanvasElement;
      return {} as HTMLElement;
    });

    const { extractVideoFrames } = await import("./extract-video-frames");
    const promise = extractVideoFrames(videoFile(), {
      maxFrames: 2,
      seekTimeoutMs: 10,
    });

    fakeVideo.duration = 4;
    fakeVideo.dispatchEvent(new Event("loadedmetadata"));

    // Never dispatch "seeked" for the first frame (it times out); dispatch for
    // the second so it succeeds.
    await new Promise((r) => setTimeout(r, 20));
    fakeVideo.dispatchEvent(new Event("seeked"));

    const frames = await promise;
    expect(frames).toHaveLength(1);
  });
});
