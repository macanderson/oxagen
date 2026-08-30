"use client";

// extract-video-frames.ts — best-effort in-browser video keyframe extraction.
//
// Non-Gemini text models cannot see video (supportsVideoInput gates the
// server from ever sending video bytes to them — see the chat stream route's
// vision/video guard). Grabbing a handful of evenly-spaced frames client-side
// and uploading them as ordinary "image" attachments lets those models still
// "see" a rough visual summary of an attached video, without any server-side
// transcoding infrastructure.
//
// This MUST degrade gracefully: an unsupported codec/container, a browser
// that refuses to decode the file, or any other failure returns an empty
// array rather than throwing — the composer still uploads the raw video and
// the user can send it either way (see message-composer.tsx's video-attach
// path). Never block send on this.

/** One extracted keyframe, ready to upload as an "image" attachment. */
export interface ExtractedVideoFrame {
  blob: Blob;
  /** Timestamp within the source video the frame was captured at. */
  atSeconds: number;
}

export interface ExtractVideoFramesOptions {
  /** Maximum number of evenly-spaced frames to extract. Default 6. */
  maxFrames?: number;
  /** Output image MIME type for each frame. Default "image/webp". */
  mimeType?: string;
  /** Encoder quality, 0-1. Default 0.8. */
  quality?: number;
  /** Timeout waiting for video metadata to load, ms. Default 10s. */
  metadataTimeoutMs?: number;
  /** Timeout waiting for a single seek to settle, ms. Default 5s. */
  seekTimeoutMs?: number;
}

const DEFAULT_MAX_FRAMES = 6;
const DEFAULT_MIME_TYPE = "image/webp";
const DEFAULT_QUALITY = 0.8;
const DEFAULT_METADATA_TIMEOUT_MS = 10_000;
const DEFAULT_SEEK_TIMEOUT_MS = 5_000;

/**
 * Extract up to `maxFrames` evenly-spaced keyframes from a video `File` as
 * in-browser webp blobs, using a hidden `<video>` + `<canvas>`. Never throws —
 * any failure (unsupported codec, decode error, missing canvas 2D context)
 * resolves to an empty array so the caller can degrade to "video uploaded, no
 * frames" without special-casing errors.
 */
export async function extractVideoFrames(
  file: File,
  opts: ExtractVideoFramesOptions = {},
): Promise<ExtractedVideoFrame[]> {
  const maxFrames = Math.max(1, opts.maxFrames ?? DEFAULT_MAX_FRAMES);
  const mimeType = opts.mimeType ?? DEFAULT_MIME_TYPE;
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const metadataTimeoutMs =
    opts.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  const seekTimeoutMs = opts.seekTimeoutMs ?? DEFAULT_SEEK_TIMEOUT_MS;

  let objectUrl: string | undefined;
  try {
    objectUrl = URL.createObjectURL(file);
  } catch {
    return [];
  }

  try {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;

    try {
      await waitForEvent(video, "loadedmetadata", metadataTimeoutMs);
    } catch {
      return [];
    }

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return [];

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];

    const frames: ExtractedVideoFrame[] = [];
    for (let i = 0; i < maxFrames; i += 1) {
      // Evenly spaced across (0, duration), never exactly at either edge —
      // the very first/last frame of many containers decodes black.
      const atSeconds = ((i + 1) / (maxFrames + 1)) * duration;
      try {
        await seekTo(video, atSeconds, seekTimeoutMs);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await canvasToBlob(canvas, mimeType, quality);
        if (blob) frames.push({ blob, atSeconds });
      } catch {
        // Best-effort per-frame: skip this frame, keep going.
      }
    }
    return frames;
  } catch {
    return [];
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function waitForEvent(
  target: HTMLMediaElement,
  eventName: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for "${eventName}"`));
    }, timeoutMs);
    function onEvent(): void {
      cleanup();
      resolve();
    }
    function onError(): void {
      cleanup();
      reject(new Error("Media element reported an error"));
    }
    function cleanup(): void {
      clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    }
    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function seekTo(
  video: HTMLVideoElement,
  atSeconds: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out seeking"));
    }, timeoutMs);
    function onSeeked(): void {
      cleanup();
      resolve();
    }
    function onError(): void {
      cleanup();
      reject(new Error("Media element reported a seek error"));
    }
    function cleanup(): void {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    }
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = atSeconds;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}
