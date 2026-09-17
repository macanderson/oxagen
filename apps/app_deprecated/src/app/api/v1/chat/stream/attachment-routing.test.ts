/**
 * attachment-routing.test.ts — unit tests for the pure three-way video
 * routing decision (video-capable → file part; vision-only → keyframes;
 * neither → error), mirroring how the image path's vision guard is exercised.
 *
 * Capability lookups are injected as predicates over a tiny fake catalog, so
 * these tests never touch the real @oxagen/ai model catalog.
 */

import { describe, it, expect } from "vitest";
import {
  decideAttachmentRouting,
  NO_VISION_MODEL_MESSAGE,
  NO_VIDEO_SUPPORT_MESSAGE,
  type AttachmentRoutingInput,
} from "./attachment-routing";

// Fake catalog: model id → capabilities.
const CATALOG: Record<string, { vision: boolean; video: boolean }> = {
  "google/gemini-3": { vision: true, video: true }, // video-capable
  "anthropic/claude": { vision: true, video: false }, // vision-only
  "openai/o-text": { vision: false, video: false }, // neither
};

const supportsVision = (m: string) => CATALOG[m]?.vision ?? false;
const supportsVideoInput = (m: string) => CATALOG[m]?.video ?? false;

function base(
  overrides: Partial<AttachmentRoutingInput>,
): AttachmentRoutingInput {
  return {
    model: "anthropic/claude",
    images: [],
    videos: [],
    supportsVision,
    supportsVideoInput,
    upgradeCandidates: [],
    ...overrides,
  };
}

describe("decideAttachmentRouting — images only (regression of the vision guard)", () => {
  it("passes images through unchanged on a vision-capable model", () => {
    const d = decideAttachmentRouting(
      base({ model: "anthropic/claude", images: [{ publicId: "img_1" }] }),
    );
    expect(d).toEqual({
      kind: "ok",
      model: "anthropic/claude",
      imagePublicIds: ["img_1"],
      videoPublicIds: [],
    });
  });

  it("upgrades a non-vision model to a vision-capable candidate for images", () => {
    const d = decideAttachmentRouting(
      base({
        model: "openai/o-text",
        images: [{ publicId: "img_1" }],
        upgradeCandidates: ["anthropic/claude"],
      }),
    );
    expect(d.kind).toBe("ok");
    if (d.kind !== "ok") return;
    expect(d.model).toBe("anthropic/claude");
    expect(d.imagePublicIds).toEqual(["img_1"]);
  });

  it("errors when no vision-capable model exists for an image", () => {
    const d = decideAttachmentRouting(
      base({
        model: "openai/o-text",
        images: [{ publicId: "img_1" }],
        upgradeCandidates: ["openai/o-text"],
      }),
    );
    expect(d).toEqual({ kind: "error", message: NO_VISION_MODEL_MESSAGE });
  });
});

describe("decideAttachmentRouting — video-capable path", () => {
  it("sends the video as a file part when the picked model is video-capable", () => {
    const d = decideAttachmentRouting(
      base({ model: "google/gemini-3", videos: [{ publicId: "vid_1" }] }),
    );
    expect(d).toEqual({
      kind: "ok",
      model: "google/gemini-3",
      imagePublicIds: [],
      videoPublicIds: ["vid_1"],
    });
  });

  it("upgrades to a video-capable candidate and drops that video's keyframes", () => {
    const d = decideAttachmentRouting(
      base({
        model: "anthropic/claude", // vision-only, but a video-capable upgrade exists
        videos: [{ publicId: "vid_1" }],
        images: [
          { publicId: "kf_1", keyframeForVideo: "vid_1" },
          { publicId: "kf_2", keyframeForVideo: "vid_1" },
          { publicId: "user_img" }, // a plain user image survives
        ],
        upgradeCandidates: ["google/gemini-3"],
      }),
    );
    expect(d.kind).toBe("ok");
    if (d.kind !== "ok") return;
    expect(d.model).toBe("google/gemini-3");
    expect(d.videoPublicIds).toEqual(["vid_1"]);
    // keyframes of vid_1 dropped; the plain user image is kept
    expect(d.imagePublicIds).toEqual(["user_img"]);
  });
});

describe("decideAttachmentRouting — vision-only keyframe fallback", () => {
  it("uses keyframes when no video-capable model exists but the model has vision", () => {
    const d = decideAttachmentRouting(
      base({
        model: "anthropic/claude",
        videos: [{ publicId: "vid_1" }],
        images: [
          { publicId: "kf_1", keyframeForVideo: "vid_1" },
          { publicId: "kf_2", keyframeForVideo: "vid_1" },
        ],
        upgradeCandidates: ["anthropic/claude"], // no video-capable candidate
      }),
    );
    expect(d.kind).toBe("ok");
    if (d.kind !== "ok") return;
    expect(d.model).toBe("anthropic/claude");
    expect(d.videoPublicIds).toEqual([]);
    // keyframes ride the image path
    expect(d.imagePublicIds).toEqual(["kf_1", "kf_2"]);
  });

  it("upgrades a non-vision model to a vision candidate for the keyframe path", () => {
    const d = decideAttachmentRouting(
      base({
        model: "openai/o-text", // neither vision nor video
        videos: [{ publicId: "vid_1" }],
        images: [{ publicId: "kf_1", keyframeForVideo: "vid_1" }],
        // no video-capable candidate, but a vision-capable one exists
        upgradeCandidates: ["anthropic/claude"],
      }),
    );
    expect(d.kind).toBe("ok");
    if (d.kind !== "ok") return;
    expect(d.model).toBe("anthropic/claude");
    expect(d.videoPublicIds).toEqual([]);
    expect(d.imagePublicIds).toEqual(["kf_1"]);
  });

  it("errors when the vision-only path is taken but a video has no keyframes", () => {
    const d = decideAttachmentRouting(
      base({
        model: "anthropic/claude",
        videos: [{ publicId: "vid_1" }],
        images: [], // extraction failed — no frames
        upgradeCandidates: ["anthropic/claude"],
      }),
    );
    expect(d).toEqual({ kind: "error", message: NO_VIDEO_SUPPORT_MESSAGE });
  });

  it("errors when only SOME videos have keyframes (never silently drop one)", () => {
    const d = decideAttachmentRouting(
      base({
        model: "anthropic/claude",
        videos: [{ publicId: "vid_1" }, { publicId: "vid_2" }],
        images: [{ publicId: "kf_1", keyframeForVideo: "vid_1" }], // vid_2 has none
        upgradeCandidates: ["anthropic/claude"],
      }),
    );
    expect(d).toEqual({ kind: "error", message: NO_VIDEO_SUPPORT_MESSAGE });
  });
});

describe("decideAttachmentRouting — no vision, no video, no upgrade", () => {
  it("errors when the model can neither see images nor video and no upgrade helps", () => {
    const d = decideAttachmentRouting(
      base({
        model: "openai/o-text",
        videos: [{ publicId: "vid_1" }],
        images: [{ publicId: "kf_1", keyframeForVideo: "vid_1" }],
        upgradeCandidates: ["openai/o-text"], // nothing better
      }),
    );
    expect(d).toEqual({ kind: "error", message: NO_VISION_MODEL_MESSAGE });
  });
});

describe("decideAttachmentRouting — no attachments", () => {
  it("is a no-op passthrough with empty lists", () => {
    const d = decideAttachmentRouting(base({ model: "anthropic/claude" }));
    expect(d).toEqual({
      kind: "ok",
      model: "anthropic/claude",
      imagePublicIds: [],
      videoPublicIds: [],
    });
  });
});
