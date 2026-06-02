export type Capability = "reasoning" | "vision" | "tools" | "image" | "video" | "audio"

export type Vendor =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "meta"
  | "mistral"
  | "deepseek"
  | "bfl"

export type EffortLevel = "low" | "medium" | "high"

export type GatewayModel = {
  /** Vercel AI Gateway model string, e.g. "anthropic/claude-opus-4.8" */
  id: string
  name: string
  vendor: Vendor
  /** ISO date the model was released */
  released: string
  capabilities: Capability[]
  /** Human context-window label, e.g. "200K" */
  context?: string
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
}

/**
 * White-labeled Oxagen tiers. Each maps to a concrete provider/model that
 * powers it — surfaced to customers as muted helper text.
 */
export type OxagenTier = {
  id: "mini" | "plus" | "max"
  name: string
  blurb: string
  /** The underlying gateway model id this tier resolves to. */
  modelId: string
}

export const oxagenTiers: OxagenTier[] = [
  {
    id: "mini",
    name: "Oxagen Mini",
    blurb: "Fastest, great for everyday tasks",
    modelId: "anthropic/claude-haiku-4.5",
  },
  {
    id: "plus",
    name: "Oxagen+",
    blurb: "Balanced quality and speed",
    modelId: "anthropic/claude-sonnet-4.6",
  },
  {
    id: "max",
    name: "Oxagen+ Max",
    blurb: "Most capable, deep reasoning",
    modelId: "anthropic/claude-opus-4.8",
  },
]

/**
 * Full Vercel AI Gateway catalog surfaced under "Other models…".
 * Ordered roughly by vendor then capability.
 */
export const gatewayModels: GatewayModel[] = [
  // Anthropic (also back the Oxagen tiers)
  {
    id: "anthropic/claude-opus-4.8",
    name: "Claude Opus 4.8",
    vendor: "anthropic",
    released: "2026-04-18",
    capabilities: ["reasoning", "vision", "tools"],
    context: "200K",
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    vendor: "anthropic",
    released: "2026-02-24",
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
  // OpenAI
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
  // Google
  {
    id: "google/gemini-3-pro",
    name: "Gemini 3 Pro",
    vendor: "google",
    released: "2026-01-21",
    capabilities: ["reasoning", "vision", "tools", "audio"],
    context: "1M",
  },
  {
    id: "google/gemini-3-flash",
    name: "Gemini 3 Flash",
    vendor: "google",
    released: "2026-01-21",
    capabilities: ["vision", "tools"],
    context: "1M",
  },
  {
    id: "google/gemini-3.1-flash-image-preview",
    name: "Nano Banana 2",
    vendor: "google",
    released: "2026-04-02",
    capabilities: ["vision", "image"],
    context: "32K",
  },
  {
    id: "google/veo-3",
    name: "Veo 3",
    vendor: "google",
    released: "2025-08-15",
    capabilities: ["video"],
  },
  // xAI
  {
    id: "xai/grok-4",
    name: "Grok 4",
    vendor: "xai",
    released: "2025-10-14",
    capabilities: ["reasoning", "vision", "tools"],
    context: "256K",
  },
  // Meta
  {
    id: "meta/llama-4-maverick",
    name: "Llama 4 Maverick",
    vendor: "meta",
    released: "2025-07-22",
    capabilities: ["vision", "tools"],
    context: "1M",
  },
  // Mistral
  {
    id: "mistral/mistral-large-3",
    name: "Mistral Large 3",
    vendor: "mistral",
    released: "2025-12-02",
    capabilities: ["tools"],
    context: "256K",
  },
  // DeepSeek
  {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2",
    vendor: "deepseek",
    released: "2026-01-08",
    capabilities: ["reasoning", "tools"],
    context: "128K",
  },
  // Black Forest Labs
  {
    id: "bfl/flux-2",
    name: "FLUX.2",
    vendor: "bfl",
    released: "2025-11-28",
    capabilities: ["image"],
  },
]

const modelIndex = new Map(gatewayModels.map((m) => [m.id, m]))

export function getModel(id: string): GatewayModel | undefined {
  return modelIndex.get(id)
}

/** Reasoning effort is only configurable on models that expose a reasoning capability. */
export function supportsEffort(model: GatewayModel | undefined): boolean {
  return !!model?.capabilities.includes("reasoning")
}

export function supportsImage(model: GatewayModel | undefined): boolean {
  return !!model?.capabilities.includes("image")
}

export function supportsVideo(model: GatewayModel | undefined): boolean {
  return !!model?.capabilities.includes("video")
}

export function capabilityLabel(c: Capability): string {
  switch (c) {
    case "reasoning":
      return "Reasoning"
    case "vision":
      return "Vision"
    case "tools":
      return "Tools"
    case "image":
      return "Image gen"
    case "video":
      return "Video gen"
    case "audio":
      return "Audio"
  }
}

export function formatReleaseDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}
