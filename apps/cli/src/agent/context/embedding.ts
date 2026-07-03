/**
 * Code-graph embedding client for the CLI (Group 3 context layer).
 *
 * The CLI embeds file nodes locally so `graph_query` can rank "impacted files"
 * by semantic similarity to a natural-language query — the same capability
 * `apps/app` gets from Neo4j's vector index. The GATEWAY client stays the exact
 * model, dimension, and renderer the server ingestion pipeline uses:
 * `text-embedding-3-small` (1536-d) via the Vercel AI Gateway, with embed text
 * built by `@oxagen/code-graph`'s shared `renderFileText`/`renderSymbolText`
 * (see {@link ../../../packages/code-graph/src/embed.ts}). A vector produced by
 * the gateway client is byte-compatible with `graph_node_embedding_index`, so
 * the CLI can also ship it on `graph push` and skip a redundant server re-embed.
 *
 * Two LOCAL, free, AI-SDK-free backends sit alongside the gateway so embeddings
 * work fully offline with no key: {@link OllamaEmbeddingClient}
 * (embedding-ollama.ts, an HTTP call to a local Ollama server) and the ONNX
 * client (embedding-onnx.ts, an in-process `fastembed` model). Both produce
 * vectors in a DIFFERENT vector space than the gateway's 1536-d index (a
 * 384-d or 768-d local vector would be noise there), so they are deliberately
 * NEVER shipped on `graph push` — `graph.push.ts`'s `localEmbeddingFor` only
 * attaches a vector whose `embeddingProvider` is the shared gateway model id;
 * every other provider's vectors stay purely local, and the server re-embeds
 * those files on ingest instead. That double-embed (once locally for the
 * CLI's own semantic_search, once server-side on push) is the accepted,
 * opt-in cost of running local embeddings — see `resolveEmbeddingClient`.
 *
 * When NO backend is available (no local server, no local model installed, no
 * gateway key) the client is simply unavailable and the semantic layer
 * degrades to lexical + graph traversal, which is logged.
 */
import { gateway } from "@ai-sdk/gateway";
import { embed, embedMany } from "ai";
import { CODE_EMBED_GATEWAY_MODEL, CODE_EMBED_DIM } from "@oxagen/code-graph/embed";
import { ensureGatewayKey } from "../env.js";
import { readGraphConfig, type EmbedProviderMode } from "./config.js";
import { createOllamaEmbeddingClient } from "./embedding-ollama.js";
import { createOnnxEmbeddingClient } from "./embedding-onnx.js";

/** A backend that turns text into `CODE_EMBED_DIM`-d vectors. Injectable for tests. */
export interface EmbeddingClient {
  /** The provider id stored alongside each vector so a model swap re-embeds. */
  readonly providerId: string;
  /** Vector dimension — always {@link CODE_EMBED_DIM} for the code graph. */
  readonly dimensions: number;
  /** Embed one text. */
  embed(text: string): Promise<number[]>;
  /** Embed many texts in one round-trip (order-preserving). */
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * The provider id recorded on every vector. It is the model id, so a future
 * model change automatically invalidates cached vectors (the semantic index
 * re-embeds nodes whose `embeddingProvider` no longer matches the active client).
 */
export const GATEWAY_PROVIDER_ID = CODE_EMBED_GATEWAY_MODEL;

/** The AI-SDK embed calls, injected so tests never reach the gateway. */
export interface GatewayEmbeddingDeps {
  embedOne?: (text: string) => Promise<number[]>;
  embedMany?: (texts: string[]) => Promise<number[][]>;
}

/**
 * Gateway-backed embedding client. Uses the default `gateway` provider, which
 * reads `AI_GATEWAY_API_KEY` from the environment — {@link ensureGatewayKey}
 * populates it from config / `.env.local` before the first call.
 */
export class GatewayEmbeddingClient implements EmbeddingClient {
  readonly providerId = GATEWAY_PROVIDER_ID;
  readonly dimensions = CODE_EMBED_DIM;
  private readonly embedOne: (text: string) => Promise<number[]>;
  private readonly embedManyFn: (texts: string[]) => Promise<number[][]>;

  constructor(deps: GatewayEmbeddingDeps = {}) {
    this.embedOne =
      deps.embedOne ??
      (async (text: string) => {
        const { embedding } = await embed({
          model: gateway.embeddingModel(CODE_EMBED_GATEWAY_MODEL),
          value: text,
        });
        return embedding;
      });
    this.embedManyFn =
      deps.embedMany ??
      (async (texts: string[]) => {
        if (texts.length === 0) return [];
        const { embeddings } = await embedMany({
          model: gateway.embeddingModel(CODE_EMBED_GATEWAY_MODEL),
          values: texts,
        });
        return embeddings;
      });
  }

  embed(text: string): Promise<number[]> {
    return this.embedOne(text);
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return this.embedManyFn(texts);
  }
}

/** Injectable dependencies for {@link resolveEmbeddingClient} — every tier is independently fakeable. */
export interface ResolveEmbeddingClientDeps {
  /** Hard override — bypasses ALL resolution (mode, env, config, probes). The original test seam. */
  client?: EmbeddingClient | null;
  /** Override the resolved {@link EmbedProviderMode}, bypassing env/config entirely. */
  mode?: EmbedProviderMode;
  /** Gateway-key check. Defaults to {@link ensureGatewayKey}. */
  hasKey?: (cwd: string) => boolean;
  /** Ollama tier factory. Defaults to the real {@link createOllamaEmbeddingClient} (real HTTP probe). */
  createOllamaClient?: () => Promise<EmbeddingClient | null>;
  /** ONNX tier factory. Defaults to the real {@link createOnnxEmbeddingClient} (real dynamic import). */
  createOnnxClient?: () => Promise<EmbeddingClient | null>;
}

/**
 * Resolve the embedding client for this process, or `null` when no backend is
 * available (offline / unconfigured). A `null` return is the signal for the
 * semantic index to skip vector ranking and log the degradation — it is not
 * an error.
 *
 * Tiered by {@link EmbedProviderMode} (env `OXAGEN_EMBED_PROVIDER`, then
 * `~/.config/oxagen/config.json`'s `graph.embedProvider`, then `"auto"`):
 *   - `auto`    — Ollama (if reachable) → ONNX (if installed) → gateway (if a
 *               key is configured) → `null`.
 *   - `ollama` / `onnx` / `gateway` — that single backend only, `null` if
 *               it's unavailable (no fallback chain).
 *   - `off`     — always `null`.
 *
 * The gateway tier is deliberately gated on the GATEWAY key only (not
 * `resolveAiCredential`): Anthropic has no embeddings API, so
 * ANTHROPIC_API_KEY-only BYOK runs with the gateway tier unavailable rather
 * than failing mid-index.
 *
 * `deps` lets a caller (or a test) inject a client directly (`deps.client`,
 * unchanged from before local providers existed), or fake out any individual
 * tier so a test never makes a real network call or dynamic import.
 */
export async function resolveEmbeddingClient(
  cwd: string = process.cwd(),
  deps: ResolveEmbeddingClientDeps = {},
): Promise<EmbeddingClient | null> {
  if (deps.client !== undefined) return deps.client;

  const mode = deps.mode ?? readGraphConfig().embedProvider;
  const hasKey = deps.hasKey ?? ((c: string) => ensureGatewayKey(c) !== null);
  const tryOllama = deps.createOllamaClient ?? (() => createOllamaEmbeddingClient());
  const tryOnnx = deps.createOnnxClient ?? (() => createOnnxEmbeddingClient());
  const tryGateway = (): EmbeddingClient | null => (hasKey(cwd) ? new GatewayEmbeddingClient() : null);

  switch (mode) {
    case "off":
      return null;
    case "gateway":
      return tryGateway();
    case "ollama":
      return tryOllama();
    case "onnx":
      return tryOnnx();
    case "auto":
    default:
      return (await tryOllama()) ?? (await tryOnnx()) ?? tryGateway();
  }
}
