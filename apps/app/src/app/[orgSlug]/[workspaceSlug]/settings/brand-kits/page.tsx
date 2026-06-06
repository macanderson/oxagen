/**
 * page.tsx — Workspace → Settings → Brand Kits (static mock).
 *
 * Static presentational mock — zero withTenantDb / invoke() dependencies.
 * Wire-up target: workspace.brandKits.list + workspace.brandKits.create
 *                 capabilities (content.brand_kits table, Postgres).
 */
import { Info, Palette, Plus, Type, Droplets, MessageSquare, Check } from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────────────────────

interface MockBrandKit {
  id: string;
  name: string;
  description: string;
  voice: string;
  tone: string;
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  isDefault: boolean;
  createdAt: string;
}

const MOCK_BRAND_KITS: MockBrandKit[] = [
  {
    id: "bk-01",
    name: "Oxagen Default",
    description: "Core brand voice and visual identity for all Oxagen-produced content.",
    voice: "Professional, precise, forward-looking",
    tone: "Confident, helpful, never condescending",
    primaryColor: "#6366F1",
    secondaryColor: "#22C55E",
    fontFamily: "Aeonik",
    isDefault: true,
    createdAt: "2026-05-01",
  },
  {
    id: "bk-02",
    name: "Campaign — Q2",
    description: "Lighter, warmer voice for Q2 growth campaign assets.",
    voice: "Energetic, approachable, conversational",
    tone: "Optimistic, inviting",
    primaryColor: "#F59E0B",
    secondaryColor: "#3B82F6",
    fontFamily: "Inter",
    isDefault: false,
    createdAt: "2026-05-15",
  },
  {
    id: "bk-03",
    name: "Dark Mode Studio",
    description: "High-contrast aesthetic for dark-background social and design assets.",
    voice: "Minimal, impactful",
    tone: "Direct, cool",
    primaryColor: "#C084FC",
    secondaryColor: "#1E1B4B",
    fontFamily: "Aeonik",
    isDefault: false,
    createdAt: "2026-06-01",
  },
];

// ── Sub-components ─────────────────────────────────────────────────────────────

function ColorSwatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-3.5 w-3.5 rounded-sm border border-black/10"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  );
}

function BrandKitCard({ kit }: { kit: MockBrandKit }) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border px-4 py-4 ${
        kit.isDefault ? "border-primary/40 bg-primary/5" : "border-border/60 bg-card"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{kit.name}</span>
            {kit.isDefault && (
              <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                <Check className="h-2.5 w-2.5" aria-hidden="true" />
                Default
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{kit.description}</p>
        </div>
        <button
          type="button"
          className="flex-shrink-0 rounded-md border border-border/60 bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
        >
          Edit
        </button>
      </div>

      {/* Attributes grid */}
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="flex items-start gap-1.5">
          <MessageSquare className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="font-medium text-foreground">Voice</p>
            <p className="text-muted-foreground">{kit.voice}</p>
          </div>
        </div>
        <div className="flex items-start gap-1.5">
          <Type className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="font-medium text-foreground">Typeface</p>
            <p className="text-muted-foreground">{kit.fontFamily}</p>
          </div>
        </div>
        <div className="flex items-start gap-1.5">
          <Droplets className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="font-medium text-foreground">Palette</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <ColorSwatch color={kit.primaryColor} />
              <span className="text-muted-foreground">{kit.primaryColor}</span>
              <ColorSwatch color={kit.secondaryColor} />
              <span className="text-muted-foreground">{kit.secondaryColor}</span>
            </div>
          </div>
        </div>
        <div className="flex items-start gap-1.5">
          <MessageSquare className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="font-medium text-foreground">Tone</p>
            <p className="text-muted-foreground">{kit.tone}</p>
          </div>
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground">Created {kit.createdAt}</p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettingsBrandKitsPage() {
  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      {/* Preview pill */}
      <div className="flex items-center justify-end">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" aria-hidden="true" />
          Preview · not yet wired to live data
        </span>
      </div>

      {/* Section heading + create button */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Palette className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-foreground">Brand kits</p>
            <p className="text-xs text-muted-foreground">
              Style configurations that constrain Studio output — voice, tone, color, and typography.
              Apply a brand kit when composing to stay on-brand.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New brand kit
        </button>
      </div>

      {/* Brand kit cards */}
      <div className="flex flex-col gap-3">
        {MOCK_BRAND_KITS.map((kit) => (
          <BrandKitCard key={kit.id} kit={kit} />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        The default brand kit is applied automatically in Studio Compose and agent generation tasks.
        Members can select an alternative kit per-generation.
      </p>
    </div>
  );
}
