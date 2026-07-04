"use client";

import * as React from "react";
import { FileText, Loader2, TriangleAlert, Video, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBytes } from "./registry-components/file-attachment";

/** Upload lifecycle of one composer attachment. */
export type AttachmentUploadStatus = "uploading" | "done" | "error";

/**
 * Client-side attachment state the composer tracks from the moment a file is
 * picked/pasted/dropped through upload completion. `id` is a locally-generated
 * stable key (before the server assigns a `publicId`); `publicId`/`url` are
 * set once `/api/v1/upload/attachment` resolves.
 */
export interface PendingAttachment {
  id: string;
  kind: "image" | "video" | "document";
  name: string;
  mimeType: string;
  status: AttachmentUploadStatus;
  /** 0-100. Only meaningful while `status === "uploading"`. */
  progress?: number;
  publicId?: string;
  /** Access-controlled serving URL, once uploaded. */
  url?: string;
  sizeBytes?: number;
  /** Local `URL.createObjectURL` preview — revoked once the upload finishes. */
  previewUrl?: string;
  error?: string;
}

/**
 * A single pending or sent attachment chip in the composer's attachment strip.
 * Shows an image thumbnail (once one is available) or a kind icon, the file
 * name, an upload progress bar while uploading, and a remove control.
 */
export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  /** Remove (and, if still uploading, abort) this attachment. */
  onRemove: (id: string) => void;
}) {
  const { id, kind, name, status, progress, url, previewUrl, error } = attachment;
  const thumbnailSrc = kind === "image" ? (previewUrl ?? url) : undefined;

  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 rounded-lg border border-border bg-card py-1 pl-1 pr-2 text-xs shadow-sm",
        status === "error" && "border-destructive/50",
      )}
      role="status"
      aria-label={
        status === "uploading"
          ? `Uploading ${name}`
          : status === "error"
            ? `Failed to upload ${name}`
            : `Attached ${name}`
      }
    >
      {/* Thumbnail / icon */}
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
        {thumbnailSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- ephemeral local blob/preview thumbnail; next/image requires a configured loader for blob: URLs
          <img
            src={thumbnailSrc}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : kind === "video" ? (
          <Video className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        ) : (
          <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )}
        {status === "uploading" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Loader2 className="h-4 w-4 animate-spin text-foreground" aria-hidden="true" />
          </div>
        ) : null}
        {status === "error" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <TriangleAlert className="h-4 w-4 text-destructive" aria-hidden="true" />
          </div>
        ) : null}
      </div>

      {/* Name + progress / error */}
      <div className="flex min-w-0 max-w-[160px] flex-col">
        <span className="truncate font-medium text-foreground" title={name}>
          {name}
        </span>
        {status === "uploading" ? (
          <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${Math.max(0, Math.min(100, progress ?? 0))}%` }}
            />
          </div>
        ) : status === "error" ? (
          <span className="truncate text-destructive" title={error}>
            {error ?? "Upload failed"}
          </span>
        ) : attachment.sizeBytes !== undefined ? (
          <span className="text-muted-foreground">{formatBytes(attachment.sizeBytes)}</span>
        ) : null}
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Remove ${name}`}
        onClick={() => onRemove(id)}
        className="h-5 w-5 shrink-0 p-0 opacity-70 hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
