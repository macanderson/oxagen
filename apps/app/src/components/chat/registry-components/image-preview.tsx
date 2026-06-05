"use client";

import Image from "next/image";
import { ImageOff } from "lucide-react";

export interface ImagePreviewProps {
  /**
   * Access-controlled serving URL (e.g. /api/v1/assets/gen_…) for a persisted
   * generated asset. Preferred over `dataUri`; the blob is streamed through our
   * own origin so the asset's access policy is enforced.
   */
  url?: string;
  /** Base-64 data URI (data:image/png;base64,...). Legacy/inline fallback. */
  dataUri?: string;
  /** Accessible alt text for the image. */
  alt: string;
  /** True when the image was not generated (missing key or generation failure). */
  placeholder?: boolean;
  /** Original generation prompt — shown in the empty-state. */
  prompt?: string;
  /** Error reason passed through from the handler — shown in the empty-state. */
  errorReason?: string;
}

/**
 * Renders a generated image in a card, or an empty-state when no image is
 * available (missing OPENAI_API_KEY or generation failure).
 *
 * Data URIs are rendered with next/image unoptimized=true because the
 * image optimisation pipeline cannot process inline data URIs.
 */
export default function ImagePreview({
  url,
  dataUri,
  alt,
  placeholder = false,
  prompt,
  errorReason,
}: ImagePreviewProps) {
  const src = url ?? dataUri;
  if (placeholder || !src) {
    return (
      <div
        className="rounded-2xl border border-border bg-card text-card-foreground shadow-sm overflow-hidden"
        role="figure"
        aria-label="Image generation unavailable"
      >
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center min-h-[180px] bg-muted/30 dark:bg-muted/10">
          <div className="rounded-full bg-muted p-3">
            <ImageOff
              className="size-6 text-muted-foreground"
              aria-hidden="true"
            />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              Image generation unavailable
            </p>
            <p className="text-xs text-muted-foreground max-w-xs">
              {errorReason
                ? `Generation failed: ${errorReason}`
                : "Set OPENAI_API_KEY to enable image generation."}
            </p>
            {prompt && (
              <p className="text-xs text-muted-foreground/70 italic mt-1 max-w-xs truncate">
                Prompt: {prompt}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl border border-border bg-card text-card-foreground shadow-sm overflow-hidden transition-shadow hover:shadow-md"
      role="figure"
      aria-label={alt}
    >
      <div className="relative w-full bg-muted/30 dark:bg-muted/10">
        <Image
          src={src}
          alt={alt}
          width={1024}
          height={1024}
          className="w-full h-auto object-contain max-h-[512px]"
          unoptimized={true}
          loading="lazy"
        />
      </div>
      {alt && (
        <div className="px-4 py-2.5 border-t border-border">
          <p className="text-xs text-muted-foreground truncate">{alt}</p>
        </div>
      )}
    </div>
  );
}
