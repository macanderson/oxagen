/**
 * page.tsx — Workspace → Settings → Models (static mock).
 *
 * Static presentational mock — zero withTenantDb / invoke() dependencies.
 * Wire-up target: workspace.model.settings.read + workspace.model.settings.write
 *                 via the workspaceModelSettingsReadHandler and updateWorkspaceModelsAction.
 *
 * Shows the three text tiers (fast/balanced/precise) and the two media tiers
 * (image/video basic+advanced) with a "Set as default" affordance per row.
 */
import type { Metadata } from "next";
import { Info, Cpu, Image, Video, Check } from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AI Models — Workspace Settings",
};

// ── Mock data ─────────────────────────────────────────────────────────────────

interface TextTierRow {
  id: "fast" | "balanced" | "precise";
  name: string;
  blurb: string;
  resolvedModel: string;
  vendor: string;
  context: string;
  isDefault: boolean;
}

interface MediaModelRow {
  id: string;
  name: string;
  vendor: string;
  tier: "basic" | "advanced";
  blurb: string;
  isDefault: boolean;
}

const TEXT_TIERS: TextTierRow[] = [
  {
    id: "fast",
    name: "Oxagen Fast",
    blurb: "Fastest response — great for everyday tasks and quick answers",
    resolvedModel: "Claude Haiku 4.5",
    vendor: "Anthropic",
    context: "200K",
    isDefault: false,
  },
  {
    id: "balanced",
    name: "Oxagen Balanced",
    blurb: "Balanced quality and speed — the recommended default for most workspaces",
    resolvedModel: "Claude Sonnet 4.6",
    vendor: "Anthropic",
    context: "200K",
    isDefault: true,
  },
  {
    id: "precise",
    name: "Oxagen Precise",
    blurb: "Most capable — deep reasoning, complex synthesis, and research-grade output",
    resolvedModel: "Claude Opus 4.8",
    vendor: "Anthropic",
    context: "200K",
    isDefault: false,
  },
];

const IMAGE_MODELS: MediaModelRow[] = [
  {
    id: "openai/gpt-image-1",
    name: "GPT Image 1",
    vendor: "OpenAI",
    tier: "basic",
    blurb: "Fast, high-quality image generation — best for most use cases",
    isDefault: true,
  },
  {
    id: "bfl/flux-2-max",
    name: "FLUX 2 Max",
    vendor: "Black Forest Labs",
    tier: "advanced",
    blurb: "Highest fidelity images — photorealism and fine detail",
    isDefault: false,
  },
];

const VIDEO_MODELS: MediaModelRow[] = [
  {
    id: "google/veo-3.0-generate-001",
    name: "Veo 3",
    vendor: "Google",
    tier: "basic",
    blurb: "Text-to-video up to 30 seconds — cinematic quality",
    isDefault: true,
  },
  {
    id: "google/veo-3.0-fast-generate-001",
    name: "Veo 3 Fast",
    vendor: "Google",
    tier: "advanced",
    blurb: "Faster video generation with lower latency — good for iteration",
    isDefault: false,
  },
];

// ── Sub-components ─────────────────────────────────────────────────────────────

function PreviewPill() {
  return (
    <div className="flex items-center justify-end">
      <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
        <Info className="h-3 w-3" aria-hidden="true" />
        Preview · not yet wired to live data
      </span>
    </div>
  );
}

function SectionHeading({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      <div>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function TextTierCard({ tier }: { tier: TextTierRow }) {
  return (
    <div
      className={`flex items-start justify-between gap-4 rounded-lg border px-4 py-4 transition-colors ${
        tier.isDefault
          ? "border-primary/40 bg-primary/5"
          : "border-border/60 bg-card"
      }`}
    >
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{tier.name}</span>
          {tier.isDefault && (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              <Check className="h-2.5 w-2.5" aria-hidden="true" />
              Active default
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{tier.blurb}</p>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{tier.resolvedModel}</code>
          <span>·</span>
          <span>{tier.vendor}</span>
          <span>·</span>
          <span>{tier.context} context</span>
        </div>
      </div>
      {!tier.isDefault && (
        <button
          type="button"
          className="flex-shrink-0 rounded-md border border-border/60 bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
        >
          Set as default
        </button>
      )}
    </div>
  );
}

function MediaModelCard({ model }: { model: MediaModelRow }) {
  return (
    <div
      className={`flex items-start justify-between gap-4 rounded-lg border px-4 py-4 transition-colors ${
        model.isDefault
          ? "border-primary/40 bg-primary/5"
          : "border-border/60 bg-card"
      }`}
    >
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{model.name}</span>
          <span className="rounded border border-border/50 px-1 py-0.5 text-[10px] font-medium text-muted-foreground capitalize">
            {model.tier}
          </span>
          {model.isDefault && (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              <Check className="h-2.5 w-2.5" aria-hidden="true" />
              Active default
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{model.blurb}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{model.id}</code>
          {" · "}{model.vendor}
        </p>
      </div>
      {!model.isDefault && (
        <button
          type="button"
          className="flex-shrink-0 rounded-md border border-border/60 bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
        >
          Set as default
        </button>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WorkspaceModelsPage() {
  return (
    <div className="flex flex-col gap-8 max-w-2xl">
      <PreviewPill />

      {/* Text model tiers */}
      <div className="flex flex-col gap-4">
        <SectionHeading
          icon={Cpu}
          title="Agent model tier"
          description="The default text model tier applied to every agent run in this workspace. Individual users cannot override this when a workspace default is set."
        />
        <div className="flex flex-col gap-2">
          {TEXT_TIERS.map((tier) => (
            <TextTierCard key={tier.id} tier={tier} />
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Tier-to-model resolution is controlled by platform environment variables.
          Contact your workspace admin to configure BYOK overrides under Model Keys.
        </p>
      </div>

      {/* Image model */}
      <div className="flex flex-col gap-4">
        <SectionHeading
          icon={Image}
          title="Image generation model"
          description="Default model for image generation tasks in this workspace. Applies to Studio Compose and agent-initiated image generation."
        />
        <div className="flex flex-col gap-2">
          {IMAGE_MODELS.map((m) => (
            <MediaModelCard key={m.id} model={m} />
          ))}
        </div>
      </div>

      {/* Video model */}
      <div className="flex flex-col gap-4">
        <SectionHeading
          icon={Video}
          title="Video generation model"
          description="Default model for video generation tasks. Applies to Studio Compose and agent-initiated video generation."
        />
        <div className="flex flex-col gap-2">
          {VIDEO_MODELS.map((m) => (
            <MediaModelCard key={m.id} model={m} />
          ))}
        </div>
      </div>

      {/* Footer note */}
      <p className="border-t border-border/40 pt-4 text-xs text-muted-foreground">
        Workspace model defaults take precedence over personal preferences for all members in this workspace.
        Changes take effect immediately for new agent runs.
      </p>
    </div>
  );
}
