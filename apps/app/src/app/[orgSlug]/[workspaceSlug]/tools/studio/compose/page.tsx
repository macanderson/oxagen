/**
 * page.tsx — Workspace → Studio → Compose (static mock).
 *
 * Static presentational mock — zero server/DB/handler dependencies.
 * Wire-up target: media.image.generate + media.video.generate capabilities via
 *                 the chat stream SSE endpoint (use-tool-stream.ts), plus
 *                 brand kit selection from workspace.brandKits.list.
 */
import { Info, Wand2, Image, Video, FileText, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

// ── Mock data ─────────────────────────────────────────────────────────────────

const BRAND_KITS = ["Oxagen Default", "Campaign — Q2", "Dark Mode Studio"];

const GENERATION_KINDS = [
  { id: "image",    label: "Image",      icon: Image,    description: "Generate images from a prompt with the active brand kit." },
  { id: "video",    label: "Video",      icon: Video,    description: "Text-to-video via Veo 3.0. Up to 30 seconds." },
  { id: "document", label: "Document",   icon: FileText,  description: "Long-form text — blog posts, reports, emails, social." },
];

const ASPECT_RATIOS = ["1:1 Square", "16:9 Landscape", "9:16 Portrait", "4:3 Classic"];

// ── Components ────────────────────────────────────────────────────────────────

function KindButton({
  icon: Icon,
  label,
  description,
  active,
}: {
  icon: React.ElementType;
  label: string;
  description: string;
  active: boolean;
}) {
  return (
    <button
      type="button"
      className={`flex flex-col items-start gap-1 rounded-lg border px-4 py-3 text-left transition-colors ${
        active
          ? "border-primary/50 bg-primary/5 text-foreground"
          : "border-border/60 bg-card text-muted-foreground hover:border-border hover:text-foreground"
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${active ? "text-primary" : "text-muted-foreground"}`} aria-hidden="true" />
        <span className={`text-sm font-semibold ${active ? "text-foreground" : ""}`}>{label}</span>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StudioComposePage() {
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      {/* Preview pill */}
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" aria-hidden="true" />
          Preview · not yet wired to live data
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Wand2 className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p className="text-base font-semibold text-foreground">Compose</p>
      </div>

      <p className="text-sm text-muted-foreground">
        Prompt-to-preview content generation. Select a kind, choose a brand kit, and generate. Completed generations appear in Activity → Runs and Library.
      </p>

      {/* Kind selector */}
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Generation type</p>
        <div className="grid grid-cols-3 gap-2">
          {GENERATION_KINDS.map((k, i) => (
            <KindButton
              key={k.id}
              icon={k.icon}
              label={k.label}
              description={k.description}
              active={i === 0}
            />
          ))}
        </div>
      </div>

      {/* Options row */}
      <div className="grid grid-cols-2 gap-4">
        {/* Brand kit */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Brand kit</label>
          <div className="flex items-center justify-between rounded-md border border-border/60 bg-card px-3 py-2 text-sm">
            <span>{BRAND_KITS[0]}</span>
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
        </div>
        {/* Aspect ratio */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Aspect ratio</label>
          <div className="flex items-center justify-between rounded-md border border-border/60 bg-card px-3 py-2 text-sm">
            <span>{ASPECT_RATIOS[1]}</span>
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
        </div>
      </div>

      {/* Prompt textarea */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="prompt" className="text-xs font-medium text-muted-foreground">Prompt</label>
        <textarea
          id="prompt"
          rows={5}
          placeholder="Describe what you want to generate. Brand kit constraints are applied automatically."
          className="w-full resize-none rounded-md border border-border/60 bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          aria-label="Generation prompt"
          readOnly
        />
        <p className="text-[11px] text-muted-foreground">
          Brand kit: <span className="font-medium text-foreground">{BRAND_KITS[0]}</span> · Constraints: British English, Aeonik typeface, indigo palette
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button className="gap-1.5">
          <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
          Generate
        </Button>
        <p className="text-xs text-muted-foreground">~2 credits · estimated 5–20 seconds</p>
      </div>

      {/* Preview placeholder */}
      <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/20">
        <div className="flex flex-col items-center gap-2 text-center">
          <Image className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Generation preview appears here</p>
        </div>
      </div>
    </div>
  );
}
