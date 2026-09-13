// attachment-routing.ts — pure, catalog-agnostic decision for how a chat
// turn's resolved attachments reach the model, given the picked model's
// capabilities and the workspace's upgrade candidates.
//
// Split out from route.ts so the three-way video decision (video-capable →
// file parts; vision-only → sampled keyframes; neither → hard error) is unit
// testable without a DB, storage, or catalog mock: every capability lookup is
// injected as a predicate and every upgrade candidate as a plain model id.
//
// This module NEVER fetches bytes or touches Postgres — it works purely on
// publicIds + capability booleans. The route resolves bytes separately and
// filters them by the publicId lists this decision returns.

/** An image attachment reference, possibly derived from an attached video. */
export interface ImageAttachmentRef {
  publicId: string;
  /**
   * Set when this image is a client-extracted keyframe of an attached video
   * (see extract-video-frames.ts). Used to DROP the keyframes when the video
   * itself is sent as a file part (video-capable model), and to verify every
   * video has at least one frame when falling back to the keyframe path. A
   * plain user image leaves this null/undefined.
   */
  keyframeForVideo?: string | null;
}

export interface VideoAttachmentRef {
  publicId: string;
}

export interface AttachmentRoutingInput {
  /** Gateway model id picked for this turn (before any attachment upgrade). */
  model: string;
  images: ImageAttachmentRef[];
  videos: VideoAttachmentRef[];
  /** True when the model accepts image parts (catalog `vision` capability). */
  supportsVision: (model: string) => boolean;
  /** True when the model accepts video file parts (catalog `video-input`). */
  supportsVideoInput: (model: string) => boolean;
  /**
   * Ordered gateway model ids to try upgrading to when the picked model can't
   * take an attachment kind — normally the white-labeled text tiers. The same
   * list serves both the vision and the video upgrade; each is filtered by the
   * matching predicate. Order is the preference order (balanced first).
   */
  upgradeCandidates: string[];
}

export type AttachmentRoutingDecision =
  | {
      kind: "ok";
      /** Model to run the turn on — may differ from the input after an upgrade. */
      model: string;
      /** publicIds to send as image parts (plain images + any used keyframes). */
      imagePublicIds: string[];
      /** publicIds to send as video file parts (empty on the keyframe path). */
      videoPublicIds: string[];
    }
  | { kind: "error"; message: string };

export const NO_VISION_MODEL_MESSAGE =
  "This workspace has no vision-capable model configured, so it can't read the attached image. Remove the attachment, or ask an admin to enable a vision-capable model.";

export const NO_VIDEO_SUPPORT_MESSAGE =
  "This model can't read video and no keyframes could be extracted from the attached video (its format may be unsupported by your browser). Attach the video to a video-capable model, or extract frames as images and attach those instead.";

/**
 * Decide, purely, how a turn's attachments reach the model:
 *
 *   1. Video present + model (or an upgrade candidate) is video-capable →
 *      send videos as file parts; the videos' keyframes are dropped.
 *   2. Video present + only vision-capable (after an optional upgrade) →
 *      send each video's sampled keyframes as image parts; every video MUST
 *      carry at least one keyframe, else a hard error (never silently drop).
 *   3. Video present + neither vision nor video capable, no upgrade →
 *      hard error.
 *
 * Plain images always ride the image path and trigger a vision upgrade of
 * their own if the (post-video) model still can't take image parts.
 */
export function decideAttachmentRouting(
  input: AttachmentRoutingInput,
): AttachmentRoutingDecision {
  const {
    images,
    videos,
    supportsVision,
    supportsVideoInput,
    upgradeCandidates,
  } = input;
  let model = input.model;

  let videoPath = false;
  if (videos.length > 0) {
    if (supportsVideoInput(model)) {
      videoPath = true;
    } else {
      // Mirror the vision auto-upgrade: try the tier candidates for a
      // video-capable model. If none exists, fall through to the keyframe path.
      const upgraded = upgradeCandidates.find((c) => supportsVideoInput(c));
      if (upgraded) {
        model = upgraded;
        videoPath = true;
      }
    }
  }

  let imagePublicIds: string[];
  let videoPublicIds: string[];

  if (videos.length > 0 && videoPath) {
    // Video file parts. Drop keyframes of these videos (the model sees the
    // real video); plain user images still ride along.
    videoPublicIds = videos.map((v) => v.publicId);
    imagePublicIds = images
      .filter((img) => !img.keyframeForVideo)
      .map((img) => img.publicId);
  } else if (videos.length > 0) {
    // Keyframe path: the model must be able to take image parts. Every video
    // needs at least one extracted keyframe, else we'd be silently answering
    // about a video the model never saw.
    if (!supportsVision(model)) {
      const upgraded = upgradeCandidates.find((c) => supportsVision(c));
      if (!upgraded) return { kind: "error", message: NO_VISION_MODEL_MESSAGE };
      model = upgraded;
    }
    const keyframeCountByVideo = new Map<string, number>();
    for (const img of images) {
      if (img.keyframeForVideo) {
        keyframeCountByVideo.set(
          img.keyframeForVideo,
          (keyframeCountByVideo.get(img.keyframeForVideo) ?? 0) + 1,
        );
      }
    }
    for (const video of videos) {
      if ((keyframeCountByVideo.get(video.publicId) ?? 0) === 0) {
        return { kind: "error", message: NO_VIDEO_SUPPORT_MESSAGE };
      }
    }
    videoPublicIds = [];
    imagePublicIds = images.map((img) => img.publicId);
  } else {
    videoPublicIds = [];
    imagePublicIds = images.map((img) => img.publicId);
  }

  // Final vision guard: any image parts (plain images, or keyframes) require a
  // vision-capable model. The video branch already upgraded for keyframes; this
  // catches a plain-image turn on a non-vision model.
  if (imagePublicIds.length > 0 && !supportsVision(model)) {
    const upgraded = upgradeCandidates.find((c) => supportsVision(c));
    if (!upgraded) return { kind: "error", message: NO_VISION_MODEL_MESSAGE };
    model = upgraded;
  }

  return { kind: "ok", model, imagePublicIds, videoPublicIds };
}
