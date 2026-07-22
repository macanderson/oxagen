/**
 * In-process ONNX embedding client via `fastembed` (local, free, offline after
 * the first model fetch, AI-SDK-free).
 *
 * `fastembed` (https://github.com/Anush008/fastembed-js) wraps onnxruntime-node
 * to run a small BAAI/bge embedding model fully in-process — no server, no API
 * key, no gateway. It is declared as an OPTIONAL dependency, exactly like the
 * on-device LLM runtime (`runtime/provisioning/optional-runtime.ts` —
 * `node-llama-cpp`), because its transitive deps (`onnxruntime-node`,
 * `@anush008/tokenizers`) are native NAPI bindings: the CLI must install and
 * run perfectly WITHOUT them, and the esbuild standalone bundle
 * (scripts/bundle.mjs) must never try to inline them.
 *
 * The fix is the SAME one `optional-runtime.ts` already uses: never import the
 * package with a literal specifier. `const specifier = OPTIONAL_DEP;
 * import(specifier)` defeats both `tsc`'s and esbuild's static resolution, so
 * the dependency is reached only via a genuine runtime `import()` that Node
 * resolves from `node_modules` on the machine actually running the CLI —
 * absent there (or its native binding fails to load on this platform), the
 * import throws, we catch it, and the CLI degrades to the next tier. This is
 * why adding `fastembed` can never break `oxagen` for users who don't opt into
 * local embeddings, or for a benchmark container that never `npm install`s it.
 *
 * The first real use downloads the default model (`bge-small-en-v1.5`, ~130MB)
 * to a local cache directory; every use after that is fully offline.
 *
 * Its vectors (384-d) live in a different vector space than the platform
 * gateway's 1536-d index. They remain in the checkout-local graph and the
 * provider id prevents incompatible vector spaces from being compared.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmbeddingClient } from "./embedding-types.js";

/** Prefix on every ONNX-produced `providerId`, e.g. "local-onnx:bge-small-en-v1.5". */
export const ONNX_PROVIDER_PREFIX = "local-onnx:";

/** The `fastembed` `EmbeddingModel` enum key we pin to — see file header. */
const MODEL_KEY = "BGESmallENV15"; // -> "fast-bge-small-en-v1.5", 384-d
/** Fallback dimension if fastembed's own catalog can't be consulted (should not happen). */
const FALLBACK_DIM = 384;
/** Bounds fastembed's internal ONNX-session batch size regardless of pass size. */
const ONNX_BATCH_SIZE = 32;

/** The optional package name — the one dependency the CLI can run without. */
export const OPTIONAL_DEP = "fastembed";

// ── Structural typing over fastembed's API ──────────────────────────────────
// Typed structurally against the subset we use, so we never statically import
// the package's types (it may be absent) — mirrors optional-runtime.ts.

interface FastEmbedModelInfo {
  model: string;
  dim: number;
}

interface FlagEmbeddingInstance {
  queryEmbed(query: string): Promise<number[]>;
  passageEmbed(
    texts: string[],
    batchSize?: number,
  ): AsyncGenerator<number[][], void, unknown>;
  listSupportedModels(): FastEmbedModelInfo[];
}

interface FastEmbedModule {
  EmbeddingModel: Record<string, string>;
  FlagEmbedding: {
    init(opts: {
      model: string;
      cacheDir?: string;
      showDownloadProgress?: boolean;
    }): Promise<FlagEmbeddingInstance>;
  };
}

function isFastEmbedModule(mod: unknown): mod is FastEmbedModule {
  if (!mod || typeof mod !== "object") return false;
  const m = mod as Partial<FastEmbedModule>;
  return (
    typeof m.FlagEmbedding?.init === "function" &&
    typeof m.EmbeddingModel === "object"
  );
}

/** The real dynamic import, hidden behind a non-literal specifier (see file header). */
async function defaultLoader(): Promise<unknown> {
  const specifier = OPTIONAL_DEP;
  return import(specifier);
}

/** Default local cache dir for downloaded ONNX weights (sibling of the on-device LLM cache). */
function defaultCacheDir(): string {
  return join(homedir(), ".oxagen", "models", "fastembed");
}

/**
 * True when `fastembed` is installed and importable on this machine. A pure
 * module-load check — no network call, no model download — so it is safe to
 * use as a cheap `auto`-mode candidacy test.
 */
export async function isOnnxAvailable(
  loader: () => Promise<unknown> = defaultLoader,
): Promise<boolean> {
  try {
    const mod = await loader();
    return isFastEmbedModule(mod);
  } catch {
    return false;
  }
}

function adaptFastEmbed(
  instance: FlagEmbeddingInstance,
  modelId: string,
  dimensions: number,
): EmbeddingClient {
  return {
    providerId: `${ONNX_PROVIDER_PREFIX}${modelId.replace(/^fast-/, "")}`,
    dimensions,
    embed: (text: string) => instance.queryEmbed(text),
    async embedBatch(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const out: number[][] = [];
      for await (const batch of instance.passageEmbed(texts, ONNX_BATCH_SIZE))
        out.push(...batch);
      return out;
    },
  };
}

export interface OnnxClientOptions {
  /** Override the cache dir weights download into. Defaults to ~/.oxagen/models/fastembed. */
  cacheDir?: string;
  /** Injectable module loader (tests) — see {@link defaultLoader}. */
  loader?: () => Promise<unknown>;
}

/**
 * Resolve a ready-to-use local ONNX embedding client, or `null` when
 * `fastembed` is not installed (optional dep absent), its native binding
 * fails to load on this platform, or the model fails to load/download (e.g.
 * offline on first use). Every failure mode degrades the same way — the CLI
 * never throws for a missing local backend, it moves to the next tier.
 *
 * `dimensions` comes from fastembed's own model catalog
 * (`listSupportedModels()`), not a hand-kept literal, so it can never drift
 * from the model actually shipped by the installed `fastembed` version.
 */
export async function createOnnxEmbeddingClient(
  opts: OnnxClientOptions = {},
): Promise<EmbeddingClient | null> {
  const loader = opts.loader ?? defaultLoader;
  let mod: FastEmbedModule;
  try {
    const loaded = await loader();
    if (!isFastEmbedModule(loaded)) return null;
    mod = loaded;
  } catch {
    return null;
  }

  const modelId = mod.EmbeddingModel[MODEL_KEY];
  if (!modelId) return null;

  try {
    const cacheDir = opts.cacheDir ?? defaultCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    const instance = await mod.FlagEmbedding.init({
      model: modelId,
      cacheDir,
      // The CLI TUI owns stdout/stderr rendering during an agent turn; a raw
      // download progress bar from fastembed would corrupt it. The one-time
      // model fetch still completes, just silently.
      showDownloadProgress: false,
    });
    const dims =
      instance.listSupportedModels().find((m) => m.model === modelId)?.dim ??
      FALLBACK_DIM;
    return adaptFastEmbed(instance, modelId, dims);
  } catch {
    return null;
  }
}
