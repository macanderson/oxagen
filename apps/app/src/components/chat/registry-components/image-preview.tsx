/**
 * image-preview — renders a generated or fetched image in chat.
 * File owned by the M agent; this stub is the R-agent placeholder.
 * Remove when the M agent delivers the real implementation.
 */
import type React from "react";
export interface ImagePreviewProps {
  /** Absolute URL or data-URL for the image to display */
  src: string;
  /** Accessible alt text */
  alt?: string;
  /** Optional display width in pixels */
  width?: number;
  /** Optional display height in pixels */
  height?: number;
}

export default function ImagePreview({
  src,
  alt,
  width,
  height,
}: ImagePreviewProps): React.ReactElement | null {
  console.log("[stub] image-preview — would render image", { src, alt, width, height });
  return null;
}
