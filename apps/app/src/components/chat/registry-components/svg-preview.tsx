/**
 * svg-preview — renders an inline SVG capability output in chat.
 * File owned by the M agent; this stub is the R-agent placeholder.
 * Remove when the M agent delivers the real implementation.
 */
import type React from "react";
export interface SvgPreviewProps {
  /** Raw SVG markup string or a data-URL (data:image/svg+xml;...) */
  svg: string;
  /** Optional accessible label for the image */
  alt?: string;
}

export default function SvgPreview({ svg, alt }: SvgPreviewProps): React.ReactElement | null {
  console.log("[stub] svg-preview — would render SVG output", { svgLength: svg?.length, alt });
  return null;
}
