"use client";

/**
 * ConversationFiles — a Slack-channel-files-style panel listing every
 * generated_asset attached to the active conversation, newest-first.
 *
 * Accessed via a header button that slides open a Sheet panel on the right.
 * Data is fetched client-side from GET /api/v1/conversations/[id]/assets so
 * the panel is always fresh (no RSC revalidation lag) and so it doesn't add
 * to the server-component render budget.
 *
 * Each row shows a file-type icon, the full filename (with extension), the
 * file size, the created timestamp, and a clickable affordance that opens the
 * asset in a new tab (images/video) or downloads it (documents/archives) via
 * the access-controlled /api/v1/assets/[id] serving route.
 *
 * The panel is responsive:
 *   Mobile: full-width Sheet overlay (right side)
 *   Desktop: same Sheet (the list is compact and scrollable)
 */

import * as React from "react";
import {
  FileText,
  FileArchive,
  FileSpreadsheet,
  Presentation,
  File,
  Image as ImageIcon,
  Video,
  ExternalLink,
  Download,
  Paperclip,
  LoaderCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Sheet,
  SheetTrigger,
  SheetPopup,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { ConversationAssetItem } from "@/app/api/v1/conversations/[conversationId]/assets/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format the full created timestamp, e.g. "Jun 23, 2026 · 2:34 PM". */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${date} · ${time}`;
}

/** Format bytes as a human-readable string (B / KB / MB / GB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Whether the browser can DISPLAY this type (so clicking the filename opens it
 * in a new tab to view) versus needing to download it. Mirrors the serving
 * route's `assetDispositionType` (packages/handlers/.../lib/asset-filename.ts):
 * images, video, audio, PDF and text (markdown/plain) view inline; SVG and
 * office/zip binaries download. Keyed off the authoritative mimeType, not the
 * coarse asset kind, so a `document`-kind markdown file opens to view while a
 * `document`-kind .docx downloads.
 */
function isViewableInline(mimeType: string): boolean {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "image/svg+xml") return false;
  if (type.startsWith("image/")) return true;
  if (type.startsWith("video/") || type.startsWith("audio/")) return true;
  if (type === "application/pdf") return true;
  if (type.startsWith("text/")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Kind icon
// ---------------------------------------------------------------------------

interface KindIconProps {
  kind: string;
  className?: string;
}

// Semantic color map for file-kind icons. Uses design-system tokens so the
// colors update automatically when the token values change.
const FILE_ICON_COLORS: Record<string, string> = {
  image: "text-primary",
  video: "text-secondary-foreground",
  pdf: "text-destructive",
  document: "text-info",
  spreadsheet: "text-success",
  presentation: "text-warning",
  archive: "text-warning",
};

function KindIcon({ kind, className }: KindIconProps) {
  const colorClass = FILE_ICON_COLORS[kind] ?? "text-muted-foreground";
  const merged = cn(colorClass, className);
  switch (kind) {
    case "image":
      return <ImageIcon className={merged} aria-hidden="true" />;
    case "video":
      return <Video className={merged} aria-hidden="true" />;
    case "pdf":
      return <FileText className={merged} aria-hidden="true" />;
    case "document":
      return <FileText className={merged} aria-hidden="true" />;
    case "spreadsheet":
      return <FileSpreadsheet className={merged} aria-hidden="true" />;
    case "presentation":
      return <Presentation className={merged} aria-hidden="true" />;
    case "archive":
      return <FileArchive className={merged} aria-hidden="true" />;
    default:
      return <File className={cn("text-muted-foreground", className)} aria-hidden="true" />;
  }
}

// ---------------------------------------------------------------------------
// Single asset row
// ---------------------------------------------------------------------------

// Shared action-button styling for the row's open/download affordances.
const ROW_ACTION_CLS = cn(
  "mt-0.5 shrink-0 inline-flex size-7 items-center justify-center rounded-md",
  "text-muted-foreground hover:bg-muted hover:text-foreground",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  "transition-colors",
);

function AssetRow({ item }: { item: ConversationAssetItem }) {
  // Viewable types (image/pdf/markdown/…) can be DISPLAYED, so the filename
  // links open them inline in a new tab. Non-viewable binaries (docx/zip) can
  // only be downloaded, so their filename link downloads directly.
  const viewable = isViewableInline(item.mimeType);

  return (
    <div className="group flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-muted/60 transition-colors">
      {/* Kind icon */}
      <div className="mt-0.5 shrink-0">
        <KindIcon kind={item.kind} className="size-5" />
      </div>

      {/* Name + meta — the full filename wraps so the extension is always visible */}
      <div className="min-w-0 flex-1">
        <a
          href={item.url}
          target={viewable ? "_blank" : undefined}
          rel={viewable ? "noopener noreferrer" : undefined}
          // Non-viewable files download on name-click (with the slug filename);
          // viewable files open inline to be read.
          download={viewable ? undefined : item.name}
          className={cn(
            "block break-words text-sm font-medium leading-snug text-foreground",
            "hover:text-primary hover:underline underline-offset-2",
            "focus-visible:outline-none focus-visible:text-primary focus-visible:underline",
          )}
          title={viewable ? `Open ${item.name}` : `Download ${item.name}`}
        >
          {item.name}
        </a>
        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
          {item.sizeBytes !== null ? `${formatBytes(item.sizeBytes)} · ` : null}
          {formatTimestamp(item.createdAt)}
        </p>
      </div>

      {/* Affordances (always visible). Viewable files get an "open in new tab"
          button AND a download button; non-viewable files get a download button.
          The download anchor carries the HTML `download` attribute set to the
          slug filename, which forces a same-origin download to SAVE AS that name
          regardless of how the server's Content-Disposition is set — so the file
          never lands on disk as the opaque `gen_…` id. */}
      {viewable ? (
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className={ROW_ACTION_CLS}
          aria-label={`Open ${item.name} in a new tab`}
          title={`Open ${item.name} in a new tab`}
        >
          <ExternalLink className="size-4" aria-hidden="true" />
        </a>
      ) : null}
      <a
        href={item.url}
        download={item.name}
        className={ROW_ACTION_CLS}
        aria-label={`Download ${item.name}`}
        title={`Download ${item.name}`}
      >
        <Download className="size-4" aria-hidden="true" />
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface ConversationFilesProps {
  /** publicId of the active conversation (from URL ?c= param). Null if no conversation yet. */
  conversationPublicId: string | null;
}

/**
 * Conversation files panel. Renders a trigger button; clicking it fetches the
 * asset list and opens a Sheet overlay with the file list.
 *
 * Fetch lifecycle:
 *   - Idle: button shown, no fetch in flight.
 *   - On open: fetch starts; spinner shown inside the panel.
 *   - Loaded: file list rendered (or an info Alert when empty).
 *   - Error: an error Alert with Retry (a 404 is treated as "no files", never
 *     surfaced as a scary error).
 *   - Re-open: data is re-fetched so newly generated files appear.
 */
export function ConversationFiles({ conversationPublicId }: ConversationFilesProps) {
  const [open, setOpen] = React.useState(false);
  const [assets, setAssets] = React.useState<ConversationAssetItem[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Fetch (or re-fetch) the asset list whenever the panel opens.
  React.useEffect(() => {
    if (!open || !conversationPublicId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setAssets(null);

    fetch(`/api/v1/conversations/${conversationPublicId}/assets`)
      .then(async (res) => {
        // A 404 means the conversation isn't persisted yet (or has no scope) —
        // there are simply no files to show. Treat it as an empty list rather
        // than surfacing "HTTP 404" to the user.
        if (res.status === 404) return [] as ConversationAssetItem[];
        if (!res.ok) throw new Error(`Couldn't load files (HTTP ${res.status})`);
        return res.json() as Promise<ConversationAssetItem[]>;
      })
      .then((data) => {
        if (!cancelled) {
          setAssets(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Couldn't load files";
          setError(msg);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, conversationPublicId]);

  const total = assets?.length ?? 0;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            aria-label="View conversation files"
            disabled={!conversationPublicId}
          />
        }
      >
        <Paperclip className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">Files</span>
      </SheetTrigger>

      <SheetPopup side="right" className="flex w-80 flex-col p-0 sm:max-w-sm">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="text-base">
            Conversation Files
            {total > 0 ? (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                ({total})
              </span>
            ) : null}
          </SheetTitle>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              <span>Loading files…</span>
            </div>
          ) : error ? (
            <div className="p-2">
              <Alert variant="error">
                <AlertTitle>Couldn&apos;t load files</AlertTitle>
                <AlertDescription className="mb-2">{error}</AlertDescription>
                <button
                  type="button"
                  onClick={() => {
                    // Re-trigger the fetch by toggling the panel closed/open.
                    setOpen(false);
                    setTimeout(() => setOpen(true), 50);
                  }}
                  className="text-xs font-medium text-foreground underline underline-offset-2 hover:opacity-80"
                >
                  Retry
                </button>
              </Alert>
            </div>
          ) : total === 0 ? (
            <div className="p-2">
              <Alert variant="info">
                <Paperclip className="size-4" aria-hidden="true" />
                <AlertTitle>No files yet</AlertTitle>
                <AlertDescription>
                  Files the assistant generates in this conversation — images,
                  documents, spreadsheets, and more — will appear here.
                </AlertDescription>
              </Alert>
            </div>
          ) : (
            <div className="flex flex-col">
              {assets!.map((item) => (
                <AssetRow key={item.publicId} item={item} />
              ))}
            </div>
          )}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
