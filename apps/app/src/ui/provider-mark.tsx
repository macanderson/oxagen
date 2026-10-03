// The mark of the company that makes a model, drawn beside the model's name
// wherever the app shows one (#5297). Marks come from a fixed registry
// (./provider-marks.ts). A recorded string only selects a registry entry and
// never becomes an asset URL, the rule ./harness-icon.tsx keeps for harness
// marks. Each mark is monochrome `currentColor`, so it takes the colour of the
// text beside it.
import { mono } from "./control-styles";
import { PROVIDER_MARKS, type ProviderId } from "./provider-marks";

type Mark = {
  label: string;
  paths: readonly { d: string; opacity?: number }[];
};
const MARKS: Readonly<Record<ProviderId, Mark>> = PROVIDER_MARKS;

/**
 * Other spellings of a registry id: the creator segment of a gateway or
 * OpenRouter slug, a model-funding vendor, and free text in the price book.
 */
const ALIASES: Readonly<Record<string, ProviderId>> = {
  gemini: "google",
  "google-ai-studio": "google",
  googleai: "google",
  vertexai: "vertex",
  "vertex-ai": "vertex",
  "google-vertex": "vertex",
  "amazon-bedrock": "bedrock",
  "aws-bedrock": "bedrock",
  aws: "bedrock",
  "x-ai": "xai",
  grok: "xai",
  "z-ai": "zai",
  "z.ai": "zai",
  zhipu: "zai",
  zhipuai: "zai",
  "meta-llama": "meta",
  llama: "meta",
  mistralai: "mistral",
  "mistral-ai": "mistral",
  moonshotai: "moonshot",
  "moonshot-ai": "moonshot",
  kimi: "moonshot",
  alibaba: "qwen",
  voyageai: "voyage",
  "voyage-ai": "voyage",
  "black-forest-labs": "bfl",
  gateway: "vercel",
  "vercel-ai-gateway": "vercel",
  "ai-gateway": "vercel",
  "azure-openai": "azure",
  "fireworks-ai": "fireworks",
  "together-ai": "together",
  togetherai: "together",
  "perplexity-ai": "perplexity",
};

/**
 * Model families by the start of the model's own name, for an id that names
 * no creator (`claude-opus-4`, `gpt-5`, `glm-flash-latest`).
 */
const FAMILIES: readonly (readonly [prefix: string, id: ProviderId])[] = [
  ["claude", "anthropic"],
  ["gpt", "openai"],
  ["chatgpt", "openai"],
  ["codex", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["dall-e", "openai"],
  ["text-embedding", "openai"],
  ["gemini", "google"],
  ["gemma", "google"],
  ["imagen", "google"],
  ["veo", "google"],
  ["grok", "xai"],
  ["llama", "meta"],
  ["mistral", "mistral"],
  ["mixtral", "mistral"],
  ["codestral", "mistral"],
  ["devstral", "mistral"],
  ["magistral", "mistral"],
  ["ministral", "mistral"],
  ["deepseek", "deepseek"],
  ["glm", "zai"],
  ["kimi", "moonshot"],
  ["qwen", "qwen"],
  ["command", "cohere"],
  ["voyage", "voyage"],
  ["flux", "bfl"],
  ["sonar", "perplexity"],
  ["minimax", "minimax"],
];

/** Services that route to other companies' models. A model's maker wins over them. */
const ROUTERS: ReadonlySet<ProviderId> = new Set(["openrouter", "vercel"]);

function lookup(name: string | null | undefined): ProviderId | null {
  if (!name) return null;
  const key = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (Object.hasOwn(MARKS, key)) return key as ProviderId;
  return Object.hasOwn(ALIASES, key) ? (ALIASES[key] ?? null) : null;
}

function makerOf(model: string | null | undefined): ProviderId | null {
  if (!model) return null;
  const segments = model.trim().toLowerCase().split(/[/:]/).filter(Boolean);
  // A creator segment comes before the model's own name: `anthropic/claude-…`,
  // `openrouter/z-ai/glm-…`. A router segment names no maker, so it is passed.
  for (const segment of segments.slice(0, -1)) {
    const id = lookup(segment);
    if (id !== null && !ROUTERS.has(id)) return id;
  }
  const name = segments.at(-1) ?? "";
  for (const [prefix, id] of FAMILIES) if (name.startsWith(prefix)) return id;
  return null;
}

/**
 * The registry id for a recorded provider and model. A named provider wins,
 * except a router, which yields to the maker the model id names.
 */
export function providerIdOf(
  provider: string | null | undefined,
  model?: string | null,
): ProviderId | null {
  const named = lookup(provider);
  if (named !== null && !ROUTERS.has(named)) return named;
  return makerOf(model) ?? named;
}

/** The company's name for a recorded provider and model, or null when unknown. */
export function providerNameOf(
  provider: string | null | undefined,
  model?: string | null,
): string | null {
  const id = providerIdOf(provider, model);
  return id === null ? null : MARKS[id].label;
}

export interface ProviderMarkProps {
  provider?: string | null;
  model?: string | null;
  size?: number;
  className?: string;
}

/**
 * The maker's mark alone, decorative. Keep the model or provider name in text
 * beside it. An unknown provider draws nothing.
 */
export function ProviderMark({
  provider,
  model,
  size = 16,
  className = "",
}: ProviderMarkProps) {
  const id = providerIdOf(provider, model);
  if (id === null) return null;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-provider-mark={id}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      className={`inline-block shrink-0 ${className}`}
    >
      {MARKS[id].paths.map((path) => (
        <path key={path.d} d={path.d} fillOpacity={path.opacity} />
      ))}
    </svg>
  );
}

export interface ModelLabelProps {
  model: string;
  provider?: string | null;
  /** Print the maker's name after the model, for a header or a detail row. */
  showProvider?: boolean;
  size?: number;
  className?: string;
}

/** A model's name with its maker's mark before it. */
export function ModelLabel({
  model,
  provider,
  showProvider = false,
  size = 16,
  className = "",
}: ModelLabelProps) {
  const name = showProvider ? providerNameOf(provider, model) : null;
  return (
    <span
      data-model-label={model}
      className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}
    >
      <ProviderMark provider={provider} model={model} size={size} />
      <span className={`min-w-0 truncate ${mono}`}>{model}</span>
      {name === null ? null : (
        <span className="shrink-0 text-muted-foreground">{name}</span>
      )}
    </span>
  );
}
