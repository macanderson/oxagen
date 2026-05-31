/**
 * make-video-form — renders the make-a-video request form in chat.
 * File owned by the V agent; this stub is the R-agent placeholder.
 * Remove when the V agent delivers the real implementation.
 */
import type React from "react";
export interface MakeVideoFormProps {
  /** Pre-populated prompt text for the video */
  prompt?: string;
  /** Optional aspect ratio (e.g. "16:9", "9:16", "1:1") */
  aspectRatio?: string;
  /** Optional duration in seconds */
  durationSeconds?: number;
}

export default function MakeVideoForm({
  prompt,
  aspectRatio,
  durationSeconds,
}: MakeVideoFormProps): React.ReactElement | null {
  console.log("[stub] make-video-form — would render video request form", {
    prompt,
    aspectRatio,
    durationSeconds,
  });
  return null;
}
