"use client";

/**
 * ConversationFilesList — a Slack-channel-files-style list of every
 * generated_asset attached to the active conversation, newest-first.
 *
 * This is the single, reusable list body: it owns the client-side fetch from
 * GET /api/v1/conversations/[id]/assets (always fresh — no RSC revalidation
 * lag, no server-component render-budget cost) plus the loading / error /
 * empty / list rendering. It is embedded directly in the persistent chat
 * side-panel's "Files" tab (see `workspace-context-panel.tsx`), which is now
 * the sole surface for conversation files — the old Sheet-based drawer that a
 * header paperclip button slid open has been removed as duplicate UI.
 *
 * Each row shows a file-type icon (or an inline thumbnail for images), the
 * full filename (with extension), the file size, the created timestamp, and a
 * clickable affordance that opens the asset in a new tab (images/video),
 * opens an in-app preview dialog (SVG), or downloads it (documents/archives)
 * via the access-controlled /api/v1/assets/[id] serving route.
 *
 * SVG handling (security-sensitive): the serving route forces
 * `Content-Disposition: attachment` for image/svg+xml because inline SVG
 * served from our own origin is a stored-XSS vector. Mobile browsers bounce
 * that forced download with "file not supported", so SVGs are previewed
 * IN-APP via an <img src={serveUrl}> inside a dialog — <img> requests ignore
 * Content-Disposition and the image decoder never executes scripts, so the
 * preview is XSS-safe without weakening the serve route. Never render asset
 * SVG markup with dangerouslySetInnerHTML here.
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
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatBytes } from "@/lib/utils";
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

/** Normalised media type without parameters ("image/svg+xml"). */
function baseMime(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** SVG assets get an in-app <img> preview dialog instead of open/download. */
function isSvg(mimeType: string): boolean {
  return baseMime(mimeType) === "image/svg+xml";
}

/** Any image type — rendered as an inline row thumbnail via <img>. */
function isImageMime(mimeType: string): boolean {
  return baseMime(mimeType).startsWith("image/");
}

/**
 * Whether the browser can DISPLAY this type (so clicking the filename opens it
 * in a new tab to view) versus needing to download it. Mirrors the serving
 * route's `assetDispositionType` (packages/handlers/.../lib/asset-filename.ts):
 * images, video, audio, PDF and text (markdown/plain) view inline; SVG previews
 * in-app (see isSvg) and office/zip binaries download. Keyed off the
 * authoritative mimeType, not the coarse asset kind, so a `document`-kind
 * markdown file opens to view while a `document`-kind .docx downloads.
 */
function isViewableInline(mimeType: string): boolean {
  const type = baseMime(mimeType);
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
      return (
        <File
          className={cn("text-muted-foreground", className)}
          aria-hidden="true"
        />
      );
  }
}

// ---------------------------------------------------------------------------
// Single asset row
// ---------------------------------------------------------------------------

// Shared action-button styling for the row's open/download affordances.
// ≥44px (size-11) touch targets on mobile, compact size-7 from sm up.
const ROW_ACTION_CLS = cn(
  "shrink-0 inline-flex size-11 sm:size-7 sm:mt-0.5 items-center justify-center rounded-md self-center sm:self-start",
  "text-muted-foreground hover:bg-muted hover:text-foreground",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  "transition-colors",
);

// Shared row-thumbnail: images (including SVG) render a small inline preview
// via <img> against the access-controlled serving route. <img> ignores the
// route's Content-Disposition and never executes SVG scripts, so this is
// XSS-safe for SVG too.
function RowThumbnail({ item }: { item: ConversationAssetItem }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- auth-gated same-origin asset URL; next/image optimization would proxy/re-encode (breaks SVG + auth cookies)
    <img
      src={item.url}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      className="size-10 shrink-0 rounded-md border border-border bg-muted/40 object-contain"
    />
  );
}

function AssetRow({
  item,
  onPreview,
}: {
  item: ConversationAssetItem;
  onPreview: (item: ConversationAssetItem) => void;
}) {
  // Viewable types (image/pdf/markdown/…) can be DISPLAYED, so the filename
  // links open them inline in a new tab. SVGs open an in-app preview dialog
  // (the serve route forces attachment disposition for them — see header
  // comment). Non-viewable binaries (docx/zip) can only be downloaded, so
  // their filename link downloads directly.
  const svg = isSvg(item.mimeType);
  const viewable = isViewableInline(item.mimeType);
  const thumbnail = isImageMime(item.mimeType);

  const nameCls = cn(
    "block break-words text-left text-sm font-medium leading-snug text-foreground",
    "hover:text-primary hover:underline underline-offset-2",
    "focus-visible:outline-none focus-visible:text-primary focus-visible:underline",
  );

  return (
    <div className="group flex min-h-11 items-start gap-3 rounded-lg px-3 py-3 sm:py-2.5 hover:bg-muted/60 transition-colors">
      {/* Leading visual: inline thumbnail for images (including SVG), kind icon
          otherwise. The thumbnail duplicates the name link's action, so it is
          hidden from the a11y tree and skipped in the tab order (decorative
          duplicate-link pattern) — keyboard/AT users act through the name. */}
      {thumbnail ? (
        svg ? (
          <button
            type="button"
            onClick={() => onPreview(item)}
            className="shrink-0 rounded-md"
            aria-hidden="true"
            tabIndex={-1}
            title={`Preview ${item.name}`}
          >
            <RowThumbnail item={item} />
          </button>
        ) : (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-md"
            aria-hidden="true"
            tabIndex={-1}
            title={`Open ${item.name} in a new tab`}
          >
            <RowThumbnail item={item} />
          </a>
        )
      ) : (
        <div className="mt-0.5 shrink-0">
          <KindIcon kind={item.kind} className="size-5" />
        </div>
      )}

      {/* Name + meta — the full filename wraps so the extension is always visible */}
      <div className="min-w-0 flex-1">
        {svg ? (
          <button
            type="button"
            onClick={() => onPreview(item)}
            className={nameCls}
            title={`Preview ${item.name}`}
          >
            {item.name}
          </button>
        ) : (
          <a
            href={item.url}
            target={viewable ? "_blank" : undefined}
            rel={viewable ? "noopener noreferrer" : undefined}
            // Non-viewable files download on name-click (with the slug filename);
            // viewable files open inline to be read.
            download={viewable ? undefined : item.name}
            className={nameCls}
            title={viewable ? `Open ${item.name}` : `Download ${item.name}`}
          >
            {item.name}
          </a>
        )}
        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
          {item.sizeBytes !== null ? `${formatBytes(item.sizeBytes)} · ` : null}
          {formatTimestamp(item.createdAt)}
        </p>
      </div>

      {/* Affordances (always visible). Viewable files get an "open in new tab"
          button AND a download button; SVGs get the in-app preview (name /
          thumbnail click) AND a download button; other non-viewable files get
          a download button. The download anchor carries the HTML `download`
          attribute set to the slug filename, which forces a same-origin
          download to SAVE AS that name regardless of how the server's
          Content-Disposition is set — so the file never lands on disk as the
          opaque `gen_…` id. */}
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
// SVG preview dialog
// ---------------------------------------------------------------------------

/**
 * Full-size in-app preview for an SVG asset. Rendered via <img> against the
 * serving route (XSS-safe — see file header) with a Download button, so
 * mobile users are never bounced into a forced download they can't open.
 */
function AssetPreviewDialog({
  item,
  onClose,
}: {
  item: ConversationAssetItem | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="w-[calc(100vw-2rem)] max-w-2xl p-4 sm:p-6">
        {item ? (
          <>
            <DialogHeader>
              <DialogTitle className="break-words pr-8 text-base">
                {item.name}
              </DialogTitle>
            </DialogHeader>
            <div className="flex items-center justify-center rounded-lg bg-muted/30 p-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated same-origin asset URL; <img> ignores Content-Disposition and never executes SVG scripts */}
              <img
                src={item.url}
                alt={item.name}
                className="max-h-[60dvh] max-w-full object-contain"
                decoding="async"
              />
            </div>
            <a
              href={item.url}
              download={item.name}
              className={cn(
                "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2",
                "bg-primary text-sm font-medium text-primary-foreground",
                "hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "transition-opacity",
              )}
              aria-label={`Download ${item.name}`}
            >
              <Download className="size-4" aria-hidden="true" />
              <span>Download</span>
            </a>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Reusable list body (fetch + loading/error/empty/list states)
// ---------------------------------------------------------------------------

export interface ConversationFilesListProps {
  /** publicId of the active conversation (from URL ?c= param). Null if no conversation yet. */
  conversationPublicId: string | null;
  /**
   * Whether this list should be fetching/showing data right now. The persistent
   * side-panel's "Files" tab passes `tab === "files"` so the fetch only fires
   * while that tab is visible; an always-visible embedding passes `true`.
   */
  active: boolean;
}

/**
 * The conversation-assets list: fetch lifecycle + loading/error/empty/list
 * rendering. Mounted by `WorkspaceContextPanel`'s "Files" tab — the single
 * surface for conversation files.
 *
 * Fetch lifecycle:
 *   - Idle: no fetch in flight.
 *   - On `active` becoming true: fetch starts; spinner shown.
 *   - Loaded: file list rendered (or an info Alert when empty).
 *   - Error: an error Alert with Retry (a 404 is treated as "no files", never
 *     surfaced as a scary error).
 *   - Re-activate: data is re-fetched so newly generated files appear.
 */
export function ConversationFilesList({
  conversationPublicId,
  active,
}: ConversationFilesListProps) {
  const [assets, setAssets] = React.useState<ConversationAssetItem[] | null>(
    null,
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<ConversationAssetItem | null>(
    null,
  );
  const [retryKey, setRetryKey] = React.useState(0);

  // Fetch (or re-fetch) the asset list whenever the list becomes active.
  React.useEffect(() => {
    if (!active || !conversationPublicId) return;

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
        if (!res.ok)
          throw new Error(`Couldn't load files (HTTP ${res.status})`);
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
          const msg =
            err instanceof Error ? err.message : "Couldn't load files";
          setError(msg);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [active, conversationPublicId, retryKey]);

  const total = assets?.length ?? 0;

  return (
    <>
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
              onClick={() => setRetryKey((k) => k + 1)}
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
          {/* "Download all" appears only once the conversation has MORE THAN
              ONE file — a single file's row download already covers it. The
              anchor hits the archive route, which re-lists via the capability
              and re-authorises every asset server-side, then streams one ZIP
              named after the conversation. */}
          {total > 1 ? (
            <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-1.5">
              <span className="text-xs font-medium text-muted-foreground tabular-nums">
                {total} files
              </span>
              <a
                href={`/api/v1/conversations/${conversationPublicId}/assets/archive`}
                download
                className={cn(
                  "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1",
                  "text-xs font-medium text-muted-foreground",
                  "hover:bg-muted hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "transition-colors",
                )}
                aria-label={`Download all ${total} files as a ZIP archive`}
                title={`Download all ${total} files as a ZIP archive`}
              >
                <FileArchive className="size-3.5" aria-hidden="true" />
                <span>Download all</span>
              </a>
            </div>
          ) : null}
          {assets!.map((item) => (
            <AssetRow key={item.publicId} item={item} onPreview={setPreview} />
          ))}
        </div>
      )}

      <AssetPreviewDialog item={preview} onClose={() => setPreview(null)} />
    </>
  );
}
