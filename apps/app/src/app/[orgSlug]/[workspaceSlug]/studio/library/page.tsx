/**
 * page.tsx — Workspace → Studio → Library (static mock).
 *
 * Static presentational mock — zero server/DB/handler dependencies.
 * Wire-up target: content.generatedAssets.list capability (workspace-scoped, Postgres + Vercel Blob).
 */
import { Info, LayoutGrid, Image, Video, FileText, Download, RefreshCw, MoreHorizontal } from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────────────────────

type AssetKind = "image" | "video" | "document";

interface MockAsset {
  id: string;
  kind: AssetKind;
  title: string;
  brandKit: string;
  model: string;
  createdAt: string;
  sizeLabel: string;
  dimensions?: string;
  duration?: string;
}

const MOCK_ASSETS: MockAsset[] = [
  { id: "ast-01", kind: "image",    title: "Hero image — Campaign Q2",         brandKit: "Campaign — Q2",    model: "gpt-image-1",       createdAt: "2026-06-06 13:21", sizeLabel: "1.2 MB",  dimensions: "1920×1080" },
  { id: "ast-02", kind: "document", title: "Q2 product update email",           brandKit: "Oxagen Default",  model: "claude-sonnet-4-5", createdAt: "2026-06-06 14:32", sizeLabel: "4 KB" },
  { id: "ast-03", kind: "image",    title: "Team photo background — dark theme",brandKit: "Dark Mode Studio", model: "flux-2-max",         createdAt: "2026-06-05 16:10", sizeLabel: "2.4 MB",  dimensions: "2048×2048" },
  { id: "ast-04", kind: "video",    title: "Product demo — 15s teaser",         brandKit: "Oxagen Default",  model: "veo-3.0",            createdAt: "2026-06-04 10:55", sizeLabel: "24 MB",   duration: "00:15" },
  { id: "ast-05", kind: "document", title: "Competitive analysis — Q2 pricing", brandKit: "Oxagen Default",  model: "claude-opus-4",     createdAt: "2026-06-03 09:30", sizeLabel: "12 KB" },
  { id: "ast-06", kind: "image",    title: "Social banner — launch announcement",brandKit: "Campaign — Q2",   model: "gpt-image-1",       createdAt: "2026-06-01 11:00", sizeLabel: "780 KB",  dimensions: "1200×628" },
];

const KIND_ICONS: Record<AssetKind, React.ElementType> = {
  image:    Image,
  video:    Video,
  document: FileText,
};

const KIND_STYLES: Record<AssetKind, string> = {
  image:    "bg-secondary text-secondary-foreground",
  video:    "bg-secondary text-secondary-foreground",
  document: "bg-secondary text-secondary-foreground",
};

function AssetCard({ asset }: { asset: MockAsset }) {
  const Icon = KIND_ICONS[asset.kind];
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border/60 bg-card">
      {/* Thumbnail area */}
      <div className="flex h-32 items-center justify-center bg-muted/40">
        <Icon className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
      </div>

      {/* Info */}
      <div className="flex flex-col gap-1.5 px-3 py-3">
        <div className="flex items-start justify-between gap-1">
          <p className="line-clamp-2 text-xs font-semibold leading-snug text-foreground">{asset.title}</p>
          <button
            type="button"
            aria-label="More options"
            className="ml-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
          >
            <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${KIND_STYLES[asset.kind]}`}>
            {asset.kind}
          </span>
          <span className="text-[10px] text-muted-foreground">{asset.sizeLabel}</span>
          {asset.dimensions && (
            <span className="text-[10px] text-muted-foreground">{asset.dimensions}</span>
          )}
          {asset.duration && (
            <span className="text-[10px] text-muted-foreground">{asset.duration}</span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">{asset.createdAt}</p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 border-t border-border/40 px-3 py-2">
        <button
          type="button"
          aria-label="Download"
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Download className="h-3 w-3" aria-hidden="true" />
          Download
        </button>
        <button
          type="button"
          aria-label="Re-run"
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          Re-run
        </button>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StudioLibraryPage() {
  return (
    <div className="flex flex-col gap-5">
      {/* Preview pill */}
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" aria-hidden="true" />
          Preview · not yet wired to live data
        </span>
      </div>

      <div className="flex items-center gap-2">
        <LayoutGrid className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p className="text-base font-semibold text-foreground">Library</p>
      </div>

      <p className="text-sm text-muted-foreground">
        Browse and manage saved Studio generations. Filter by brand kit, kind, or creation date. Export or re-run any generation.
      </p>

      {/* Grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {MOCK_ASSETS.map((asset) => (
          <AssetCard key={asset.id} asset={asset} />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Showing {MOCK_ASSETS.length} generations. Assets are retained for 90 days on Build plan, 1 year on Scale and Enterprise.
      </p>
    </div>
  );
}
