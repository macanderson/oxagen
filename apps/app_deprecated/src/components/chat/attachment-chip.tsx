"use client";

import * as React from "react";
import Image from "next/image";
import { X, FileText, Film, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Client-side state for one attachment in the composer's pending strip. The
 * composer owns the array; this component is a pure, presentational chip.
 *
 * Lifecycle: "uploading" (immediately after the file is picked/pasted/dropped,
 * XHR progress ticking `progress`) → "uploaded" (the `/api/v1/upload/attachment`
 * response landed — `publicId`/`url`/`mimeType` populated, safe to submit) or
 * "error" (upload failed — `error` holds a user-facing message, removable).
 */
export interface PendingAttachment {
  /** Stable client-local id (crypto.randomUUID()) — React key + remove target. */
  id: string;
  /** The original File the user picked/pasted/dropped. */
  file: File;
  /** Local object URL for an instant thumbnail before the upload completes. */
  previewUrl: string;
  status: "uploading" | "uploaded" | "error";
  /** 0-100. Meaningful only while status === "uploading". */
  progress: number;
  error?: string;
  /** Populated once status === "uploaded" — the server-assigned asset identity. */
  publicId?: string;
  kind?: string;
  mimeType?: string;
  /** Access-controlled serving URL (e.g. /api/v1/assets/gen_…) — never a raw blob URL. */
  url?: string;
  name?: string;
  /**
   * Set on a client-extracted video keyframe (Phase 2) to the LOCAL id of the
   * video attachment it was sampled from. Resolved to that video's server
   * `publicId` at submit time (the video may still be uploading when the frame
   * is created). Keyframes are `hidden` from the pending strip.
   */
  keyframeForVideoLocalId?: string;
  /** True for derived attachments (video keyframes) not shown as their own chip. */
  hidden?: boolean;
  /**
   * The upload kind actually sent to the server for this attempt (Phase 2 —
   * multimodal attach). Set at creation time and reused by RETRY to resend
   * an identical request: it's not always re-derivable from `file.type`
   * alone (e.g. a PDF picked via the v2 attach tray's "Choose files" row
   * uploads as kind="document", even though `application/pdf` doesn't start
   * with "document/").
   */
  attemptKind?: "image" | "video" | "document";
}

/** True when every attachment finished uploading (used to gate the send button). */
export function hasInFlightUploads(
  attachments: readonly PendingAttachment[],
): boolean {
  return attachments.some((a) => a.status === "uploading");
}

export function AttachmentChip({
  attachment,
  onRemove,
  onRetry,
  compact = false,
}: {
  attachment: PendingAttachment;
  onRemove: (id: string) => void;
  /**
   * Re-attempt a failed upload with the same file + kind. Omitted (the
   * default) hides the retry affordance — callers that never fail an
   * upload deterministically (none currently) can skip wiring it.
   */
  onRetry?: (id: string) => void;
  /**
   * chat_ux_v2 only: shrinks the chip from 64px to a 40px thumbnail and adds
   * a filename caption under non-image chips. Legacy callers omit this so
   * their existing layout stays byte-identical.
   */
  compact?: boolean;
}) {
  const isImage = attachment.file.type.startsWith("image/");
  const isVideo = attachment.file.type.startsWith("video/");
  const displayName = attachment.name ?? attachment.file.name;

  return (
    <div
      className={cn(
        "flex flex-col items-center",
        compact ? "w-10 gap-0.5" : "gap-1",
      )}
    >
      <div
        className={cn(
          "group relative shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted flex",
          compact ? "h-10 w-10" : "h-16 w-16",
          attachment.status === "error" &&
            "border-destructive/50 bg-destructive/5",
        )}
        data-testid="attachment-chip"
        data-status={attachment.status}
        aria-label={`Attachment: ${displayName}${attachment.status === "uploading" ? ` (uploading, ${attachment.progress}%)` : ""}${attachment.status === "error" ? " (upload failed)" : ""}`}
      >
        {isImage ? (
          <Image
            src={attachment.previewUrl}
            alt={displayName}
            fill
            unoptimized
            className="object-cover"
          />
        ) : isVideo ? (
          <Film className="size-6 text-muted-foreground" aria-hidden="true" />
        ) : (
          <FileText
            className="size-6 text-muted-foreground"
            aria-hidden="true"
          />
        )}

        {attachment.status === "uploading" ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/50 text-white"
            role="progressbar"
            aria-valuenow={attachment.progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            <span className="text-[10px] tabular-nums">
              {attachment.progress}%
            </span>
          </div>
        ) : null}

        {attachment.status === "error" ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-destructive/80 text-destructive-foreground"
            title={attachment.error ?? "Upload failed"}
          >
            <AlertCircle className="size-4" aria-hidden="true" />
            {onRetry ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Retry upload for ${displayName}`}
                onClick={() => onRetry(attachment.id)}
                className="h-4 rounded px-1 text-[9px] leading-none text-destructive-foreground hover:bg-white/20"
              >
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Remove ${displayName}`}
          onClick={() => onRemove(attachment.id)}
          className="absolute right-0.5 top-0.5 h-4 w-4 rounded-full bg-black/60 p-0 text-white opacity-0 hover:bg-black/80 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <X className="size-2.5" />
        </Button>
      </div>
      {compact && !isImage ? (
        <span
          className="max-w-10 truncate text-[9px] leading-none text-muted-foreground"
          title={displayName}
        >
          {displayName}
        </span>
      ) : null}
    </div>
  );
}
