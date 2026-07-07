"use client";

import {
  FileText,
  Sheet,
  Presentation,
  FileArchive,
  File,
  ExternalLink,
  Download,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type FileAttachmentKind =
  | "document"
  | "spreadsheet"
  | "presentation"
  | "pdf"
  | "archive";

export interface FileAttachmentProps {
  /** Access-controlled serving URL (e.g. /api/v1/assets/gen_…). */
  url: string;
  /** Display name for the file. */
  name: string;
  /** Asset kind — drives icon and label. "image" and "video" handled by separate components. */
  kind: FileAttachmentKind | string;
  /** MIME type (e.g. application/pdf). */
  mimeType?: string;
  /** Size in bytes — shown human-formatted. */
  sizeBytes?: number;
}

// Maps kind → { icon, label, colour }
interface KindMeta {
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  iconClass: string;
}

function kindMeta(kind: FileAttachmentKind | string): KindMeta {
  switch (kind) {
    case "document":
      return { Icon: FileText, label: "Document", iconClass: "text-info" };
    case "spreadsheet":
      return { Icon: Sheet, label: "Spreadsheet", iconClass: "text-success" };
    case "presentation":
      return { Icon: Presentation, label: "Presentation", iconClass: "text-warning" };
    case "pdf":
      return { Icon: FileText, label: "PDF", iconClass: "text-error" };
    case "archive":
      return { Icon: FileArchive, label: "Archive", iconClass: "text-warning" };
    default:
      return { Icon: File, label: "File", iconClass: "text-muted-foreground" };
  }
}

/** Format byte count as human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * File attachment card for generated document/spreadsheet/presentation/pdf/archive assets.
 *
 * componentId: "file-attachment"
 *
 * For image assets, use "image-preview" instead.
 * For video assets, use "video-result" instead.
 */
export default function FileAttachment({
  url,
  name,
  kind,
  mimeType,
  sizeBytes,
}: FileAttachmentProps) {
  const { Icon, label, iconClass } = kindMeta(kind);

  // PDFs are browser-renderable, so they get an open-in-new-tab affordance.
  // Other document kinds (docx/xlsx/pptx/zip/…) are download-only — the serve
  // route ships them with attachment disposition, so a new-tab "open" would
  // just be a confusing forced download (mobile browsers surface it as
  // "file not supported").
  const isPdf = kind === "pdf" || Boolean(mimeType?.startsWith("application/pdf"));
  const rel = "noopener noreferrer";

  // ≥44px touch targets on mobile (size-11), compact size-8 from sm up.
  const actionCls = cn(
    "inline-flex size-11 sm:size-8 items-center justify-center rounded-md",
    "text-muted-foreground hover:bg-muted hover:text-foreground",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    "transition-colors",
  );

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm",
        "transition-shadow hover:shadow-md",
      )}
      role="region"
      aria-label={`${label}: ${name}`}
    >
      {/* Kind icon */}
      <div className="shrink-0 rounded-lg bg-muted p-2">
        <Icon className={cn("size-5", iconClass)} aria-hidden="true" />
      </div>

      {/* File info */}
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm font-medium text-foreground"
          title={name}
        >
          {name}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {label}
          {sizeBytes !== undefined ? ` · ${formatBytes(sizeBytes)}` : null}
        </p>
      </div>

      {/* Action buttons */}
      <div className="flex shrink-0 items-center gap-1">
        {/* Open / preview — PDFs only (browser-renderable) */}
        {isPdf ? (
          <a
            href={url}
            target="_blank"
            rel={rel}
            className={actionCls}
            aria-label={`Open ${name} in new tab`}
          >
            <ExternalLink className="size-4" aria-hidden="true" />
          </a>
        ) : null}
        {/* Download */}
        <a
          href={url}
          download={name}
          rel={rel}
          className={actionCls}
          aria-label={`Download ${name}`}
        >
          <Download className="size-4" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
