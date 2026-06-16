"use client";

/**
 * ConversationFiles — a Slack-channel-files-style panel listing all
 * generated_assets for the active conversation, newest-first.
 *
 * Accessed via a header button that slides open a Sheet panel on the right.
 * Data is fetched client-side from GET /api/v1/conversations/[id]/assets so
 * the panel is always fresh (no RSC revalidation lag) and so it doesn't add
 * to the server-component render budget.
 *
 * The panel is responsive:
 *   Mobile: full-width Sheet overlay (right side)
 *   Desktop: same Sheet (the list is compact and scrollable)
 */

import * as React from "react";
import {
  FileText,
  FileArchive,
  File,
  Image as ImageIcon,
  Video,
  ExternalLink,
  Paperclip,
  LoaderCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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

/**
 * Group an asset list into labelled date buckets (Today, Yesterday, older
 * month+year labels). Each bucket has a label string and its items.
 */
interface AssetGroup {
  label: string;
  items: ConversationAssetItem[];
}

function groupByDate(assets: ConversationAssetItem[]): AssetGroup[] {
  const now = new Date();
  const todayLabel = "Today";
  const yesterdayLabel = "Yesterday";

  function bucket(iso: string): string {
    const d = new Date(iso);
    const diff = Math.floor(
      (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (diff === 0) return todayLabel;
    if (diff === 1) return yesterdayLabel;
    // e.g. "June 2025"
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  const map = new Map<string, ConversationAssetItem[]>();
  for (const asset of assets) {
    const key = bucket(asset.createdAt);
    const group = map.get(key);
    if (group) {
      group.push(asset);
    } else {
      map.set(key, [asset]);
    }
  }

  return Array.from(map.entries()).map(([label, items]) => ({ label, items }));
}

/** Format time string for display (e.g. "2:34 PM"). */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Format bytes as human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  switch (kind) {
    case "image":
      return <ImageIcon className={cn(colorClass, className)} aria-hidden="true" />;
    case "video":
      return <Video className={cn(colorClass, className)} aria-hidden="true" />;
    case "pdf":
      return <FileText className={cn(colorClass, className)} aria-hidden="true" />;
    case "document":
      return <FileText className={cn(colorClass, className)} aria-hidden="true" />;
    case "spreadsheet":
      return (
        // Lucide does not ship a Spreadsheet icon; use a styled FileText variant.
        <FileText className={cn(colorClass, className)} aria-hidden="true" />
      );
    case "presentation":
      return <FileText className={cn(colorClass, className)} aria-hidden="true" />;
    case "archive":
      return <FileArchive className={cn(colorClass, className)} aria-hidden="true" />;
    default:
      return <File className={cn("text-muted-foreground", className)} aria-hidden="true" />;
  }
}

// ---------------------------------------------------------------------------
// Single asset row
// ---------------------------------------------------------------------------

function AssetRow({ item }: { item: ConversationAssetItem }) {
  return (
    <div className="group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/60 transition-colors">
      {/* Kind icon */}
      <div className="shrink-0">
        <KindIcon kind={item.kind} className="size-4" />
      </div>

      {/* Name + meta */}
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm font-medium text-foreground leading-snug"
          title={item.name}
        >
          {item.name}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {formatTime(item.createdAt)}
          {item.sizeBytes !== null ? ` · ${formatBytes(item.sizeBytes)}` : null}
        </p>
      </div>

      {/* Open link */}
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "shrink-0 inline-flex size-7 items-center justify-center rounded-md",
          "text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground",
          "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "transition-all",
        )}
        aria-label={`Open ${item.name}`}
      >
        <ExternalLink className="size-3.5" aria-hidden="true" />
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
 * asset list and opens a Sheet overlay with the grouped file list.
 *
 * Fetch lifecycle:
 *   - Idle: button shown, no fetch in flight.
 *   - On open: fetch starts; spinner shown inside the panel.
 *   - Loaded: grouped list rendered.
 *   - Error: brief error message with retry.
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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
          const msg = err instanceof Error ? err.message : "Failed to load files";
          setError(msg);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, conversationPublicId]);

  const groups = assets ? groupByDate(assets) : [];
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

        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              <span>Loading files…</span>
            </div>
          ) : error ? (
            <div className="px-4 py-8 text-center">
              <p className="mb-2 text-sm text-destructive">{error}</p>
              <button
                type="button"
                onClick={() => {
                  // Re-trigger by toggling then re-opening.
                  setOpen(false);
                  setTimeout(() => setOpen(true), 50);
                }}
                className="text-xs text-muted-foreground underline hover:text-foreground"
              >
                Retry
              </button>
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
              <Paperclip className="size-6 opacity-40" aria-hidden="true" />
              <span>No files generated yet.</span>
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.label} className="mb-2">
                <header className="sticky top-0 bg-background px-3 py-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </p>
                </header>
                {group.items.map((item) => (
                  <AssetRow key={item.publicId} item={item} />
                ))}
              </section>
            ))
          )}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
