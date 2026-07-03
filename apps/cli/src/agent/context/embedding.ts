/**
 * Code-graph embedding client for the CLI (Group 3 context layer).
 *
 * The CLI embeds file nodes locally so `graph_query` can rank "impacted files"
 * by semantic similarity to a natural-language query — the same capability
 * `apps/app` gets from Neo4j's vector index. To stay compatible across surfaces
 * it uses the EXACT model, dimension, and renderer the server ingestion pipeline
 * uses: `text-embedding-3-small` (1536-d) via the Vercel AI Gateway, with embed
 * text built by `@oxagen/code-graph`'s shared `renderFileText`/`renderSymbolText`
 * (see {@link ../../../packages/code-graph/src/embed.ts}). A vector produced here
 * is byte-compatible with `graph_node_embedding_index`, so the CLI can also ship
 * these vectors on `graph push` and skip a redundant server re-embed.
 *
 * The gateway is the ONLY embedding backend — there is no bespoke local model
 * that would fragment the vector space (a 256-d hash vector would be noise in the
 * 1536-d index). When no gateway key is resolvable the client is simply
 * unavailable and the semantic layer degrades to lexical + graph traversal,
 * which is logged. This matches the platform's gateway-only policy.
 */
import { gateway } from "@ai-sdk/gateway";
import { embed, embedMany } from "ai";
import { CODE_EMBED_GATEWAY_MODEL, CODE_EMBED_DIM } from "@oxagen/code-graph/embed";
import { ensureGatewayKey } from "../env.js";

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

/**
 * Resolve the embedding client for this process, or `null` when no gateway
 * credential is available (offline / unconfigured). A `null` return is the
 * signal for the semantic index to skip vector ranking and log the degradation
 * — it is not an error.
 *
 * Deliberately gated on the GATEWAY key only (not `resolveAiCredential`):
 * Anthropic has no embeddings API, so ANTHROPIC_API_KEY-only BYOK runs with
 * vector ranking disabled rather than failing mid-index.
 *
 * `deps` lets a caller (or a test) inject a client directly, bypassing key
 * resolution entirely.
 */
export function resolveEmbeddingClient(
  cwd: string = process.cwd(),
  deps: { client?: EmbeddingClient | null; hasKey?: (cwd: string) => boolean } = {},
): EmbeddingClient | null {
  if (deps.client !== undefined) return deps.client;
  const hasKey = deps.hasKey ?? ((c: string) => ensureGatewayKey(c) !== null);
  if (!hasKey(cwd)) return null;
  return new GatewayEmbeddingClient();
}
