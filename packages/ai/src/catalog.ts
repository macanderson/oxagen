// Client-safe model catalog — display metadata + capability flags for the
// Vercel AI Gateway models surfaced in the Oxagen model picker.
//
// IMPORTANT: this module must stay free of any `@ai-sdk/*` / `ai` imports so it
// can be imported from BOTH the server (route capability guards) and the client
// (the model picker UI). It is exposed under the `@oxagen/ai/catalog` subpath
// (see package.json `exports`) precisely so a React client component can pull
// the catalog without dragging the provider SDKs into the browser bundle.
//
// The catalog is the single source of truth for *what a model can do* (the
// `capabilities` array). The concrete model a tier resolves to is owned by the
// `OXAGEN_LLM_*` env vars (server-only, see ./models.ts) — the two are joined
// at runtime via `resolvedTierCatalog()`.

export type Capability =
  | "reasoning"
  | "vision"
  | "tools"
  | "image"
  | "video"
  | "video-input"
  | "audio";

export type Vendor =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "meta"
  | "mistral"
  | "deepseek"
  | "bfl";

/**
 * Reasoning effort surfaced to reasoning-capable models.
 *
 * `low | medium | high` are the cross-vendor baseline. `xhigh` and `max` are the
 * deepest tiers Anthropic's adaptive-thinking models (Claude Opus) expose; for
 * vendors without those tiers (e.g. OpenAI's `reasoning_effort`, which tops out
 * at `high`) they are clamped down to `high` in {@link reasoningRequestConfig}.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Media generation kinds the composer can request. */
export type MediaKind = "image" | "video";

/** White-labeled text tiers (resolve to OXAGEN_LLM_FAST/BALANCED/PRECISE). */
export type TextTier = "fast" | "balanced" | "precise";

/** White-labeled media tiers (resolve to OXAGEN_LLM_{IMAGE,VIDEO}_{BASIC,ADVANCED}). */
export type MediaTier = "basic" | "advanced";

export interface GatewayModel {
  /** Vercel AI Gateway model string, e.g. "anthropic/claude-opus-4.8". */
  id: string;
  name: string;
  vendor: Vendor;
  /** ISO date the model was released. */
  released: string;
  capabilities: Capability[];
  /** Human context-window label, e.g. "200K". */
  context?: string;
}

export const vendorLabels: Record<Vendor, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  meta: "Meta",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  bfl: "Black Forest Labs",
};

/**
 * Display metadata for the three white-labeled text tiers. The concrete model
 * each maps to is resolved from env at runtime (resolvedTierCatalog), so these
 * names stay decoupled from the underlying vendor model.
 */
export const TEXT_TIERS: { id: TextTier; name: string; blurb: string }[] = [
  {
    id: "fast",
    name: "Oxagen Fast",
    blurb: "Fastest — great for everyday tasks",
  },
  {
    id: "balanced",
    name: "Oxagen Balanced",
    blurb: "Balanced quality and speed",
  },
  {
    id: "precise",
    name: "Oxagen Precise",
    blurb: "Most capable, deep reasoning",
  },
];

/** Display metadata for the two white-labeled media tiers (image + video). */
export const MEDIA_TIERS: { id: MediaTier; name: string; blurb: string }[] = [
  { id: "basic", name: "Oxagen Basic", blurb: "Fast, economical generation" },
  { id: "advanced", name: "Oxagen Advanced", blurb: "Highest fidelity" },
];

/**
 * Full Vercel AI Gateway catalog surfaced under "Other models…". Ordered
 * roughly by vendor then capability. The `capabilities` array drives which
 * models are selectable in each composer mode (text / image / video).
 */
export const gatewayModels: GatewayModel[] = [
  // ── Anthropic (also back the Oxagen text tiers) ──
  {
    id: "anthropic/claude-fable-5",
    name: "Claude Fable 5",
    vendor: "anthropic",
    released: "2026-06-24",
    capabilities: ["reasoning", "vision", "tools"],
    context: "1M",
  },
  {
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    vendor: "anthropic",
    released: "2026-06-24",
    capabilities: ["reasoning", "vision", "tools"],
    context: "1M",
  },
  {
    id: "anthropic/claude-opus-4.8",
    name: "Claude Opus 4.8",
    vendor: "anthropic",
    released: "2026-04-18",
    capabilities: ["reasoning", "vision", "tools"],
    context: "200K",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    vendor: "anthropic",
    released: "2025-11-12",
    capabilities: ["vision", "tools"],
    context: "200K",
  },
  // ── OpenAI ──
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    vendor: "openai",
    released: "2026-03-05",
    capabilities: ["reasoning", "vision", "tools"],
    context: "400K",
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 mini",
    vendor: "openai",
    released: "2025-09-30",
    capabilities: ["reasoning", "tools"],
    context: "256K",
  },
  {
    id: "openai/o4",
    name: "o4",
    vendor: "openai",
    released: "2025-12-09",
    capabilities: ["reasoning", "tools"],
    context: "200K",
  },
  {
    id: "openai/gpt-image-1",
    name: "GPT Image 1",
    vendor: "openai",
    released: "2025-04-23",
    capabilities: ["image"],
  },
  // ── Google ──
  {
    id: "google/gemini-3-pro",
    name: "Gemini 3 Pro",
    vendor: "google",
    released: "2026-01-21",
    // Gemini natively accepts video file parts as model input (video-input),
    // distinct from the video *generation* capability (Veo).
    capabilities: ["reasoning", "vision", "tools", "audio", "video-input"],
    context: "1M",
  },
  {
    id: "google/gemini-3-flash",
    name: "Gemini 3 Flash",
    vendor: "google",
    released: "2026-01-21",
    capabilities: ["vision", "tools", "video-input"],
    context: "1M",
  },
  {
    id: "google/gemini-3.1-flash-image-preview",
    name: "Gemini 3.1 Flash Image",
    vendor: "google",
    released: "2026-04-02",
    capabilities: ["vision", "image"],
    context: "32K",
  },
  {
    id: "google/veo-3.0-generate-001",
    name: "Veo 3",
    vendor: "google",
    released: "2025-08-15",
    capabilities: ["video"],
  },
  {
    id: "google/veo-3.0-fast-generate-001",
    name: "Veo 3 Fast",
    vendor: "google",
    released: "2025-08-15",
    capabilities: ["video"],
  },
  // ── xAI ──
  {
    id: "xai/grok-4",
    name: "Grok 4",
    vendor: "xai",
    released: "2025-10-14",
    capabilities: ["reasoning", "vision", "tools"],
    context: "256K",
  },
  // ── Meta ──
  {
    id: "meta/llama-4-maverick",
    name: "Llama 4 Maverick",
    vendor: "meta",
    released: "2025-07-22",
    capabilities: ["vision", "tools"],
    context: "1M",
  },
  // ── Mistral ──
  {
    id: "mistral/mistral-large-3",
    name: "Mistral Large 3",
    vendor: "mistral",
    released: "2025-12-02",
    capabilities: ["tools"],
    context: "256K",
  },
  // ── DeepSeek ──
  {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2",
    vendor: "deepseek",
    released: "2026-01-08",
    capabilities: ["reasoning", "tools"],
    context: "128K",
  },
  // ── Black Forest Labs ──
  {
    id: "bfl/flux-2-max",
    name: "FLUX.2 Max",
    vendor: "bfl",
    released: "2025-11-28",
    capabilities: ["image"],
  },
];

const modelIndex = new Map(gatewayModels.map((m) => [m.id, m]));

export function getModel(id: string): GatewayModel | undefined {
  return modelIndex.get(id);
}

/** Resolve a (possibly id-string) argument to a GatewayModel. */
function resolve(
  model: string | GatewayModel | undefined,
): GatewayModel | undefined {
  if (model === undefined) return undefined;
  return typeof model === "string" ? getModel(model) : model;
}

/**
 * Reasoning effort is only configurable on models that expose a reasoning
 * capability. An unknown id (not in the catalog) returns false — the caller
 * should not assume effort support for a model it can't describe.
 */
export function supportsReasoning(
  model: string | GatewayModel | undefined,
): boolean {
  return !!resolve(model)?.capabilities.includes("reasoning");
}

/**
 * A model accepts IMAGE input (multimodal chat attachments) when it carries the
 * `vision` capability. Distinct from `supportsImage` (image *generation*). An
 * unknown id returns false — never assume a model the catalog can't describe
 * can take image parts.
 */
export function supportsVision(
  model: string | GatewayModel | undefined,
): boolean {
  return !!resolve(model)?.capabilities.includes("vision");
}

/**
 * A model accepts VIDEO input (video file parts, e.g. Gemini) when it carries
 * the `video-input` capability. Distinct from `supportsVideo` (video
 * *generation*, e.g. Veo). Models without it fall back to sampled keyframes.
 */
export function supportsVideoInput(
  model: string | GatewayModel | undefined,
): boolean {
  return !!resolve(model)?.capabilities.includes("video-input");
}

export function supportsImage(
  model: string | GatewayModel | undefined,
): boolean {
  return !!resolve(model)?.capabilities.includes("image");
}

export function supportsVideo(
  model: string | GatewayModel | undefined,
): boolean {
  return !!resolve(model)?.capabilities.includes("video");
}

/**
 * A model is "text-capable" when it can take part in a chat turn — i.e. it has
 * at least one non-media capability. Pure image/video models (GPT Image, Veo,
 * FLUX) are not selectable in the text composer.
 */
export function supportsText(
  model: string | GatewayModel | undefined,
): boolean {
  const caps = resolve(model)?.capabilities ?? [];
  return caps.some((c) => c !== "image" && c !== "video");
}

/** True when the model can produce the requested media kind. */
export function supportsMedia(
  model: string | GatewayModel | undefined,
  kind: MediaKind,
): boolean {
  return kind === "image" ? supportsImage(model) : supportsVideo(model);
}

export function capabilityLabel(c: Capability): string {
  switch (c) {
    case "reasoning":
      return "Reasoning";
    case "vision":
      return "Vision";
    case "tools":
      return "Tools";
    case "image":
      return "Image gen";
    case "video":
      return "Video gen";
    case "video-input":
      return "Video input";
    case "audio":
      return "Audio";
  }
}

export function formatReleaseDate(iso: string): string {
  // Use UTC so the formatted date is deterministic across server/client
  // timezones (avoids hydration drift on the picker's release-date label).
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The runtime config the model picker needs: the white-labeled tiers joined to
 * the concrete gateway model ids resolved from env. Built server-side (it reads
 * env) and passed to the client picker as a single serializable prop, so the
 * picker can label each tier with its underlying model without the client ever
 * reading env. The string values are the concern of ./models.ts.
 */
export interface ResolvedTierCatalog {
  text: Record<TextTier, string>;
  image: Record<MediaTier, string>;
  video: Record<MediaTier, string>;
}

// Re-export the pure client-safe model-default resolver so it is available
// from the "@oxagen/ai/catalog" subpath (client components) without any
// provider-SDK or DB imports entering the bundle.
export { resolveModelDefaults } from "./resolve-model-defaults";
export type {
  ModelTier,
  ModelDefaultsInput,
  ResolvedModelDefaults,
} from "./resolve-model-defaults";
