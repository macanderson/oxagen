/**
 * Model-aware token counting.
 *
 * Provides a fast, cached token counter that selects the right encoding
 * based on the model family. Used by the packer to enforce budget constraints.
 *
 * The OpenAI and Anthropic families use their real vendor tokenizers
 * (`tiktoken` / `@anthropic-ai/tokenizer`) so budget math matches what the
 * provider actually charges. Those packages ship heavy WASM, so they are
 * loaded **lazily** — only when an OpenAI/Anthropic model is first tokenized,
 * never at module evaluation — and any load/count failure falls back to the
 * synchronous character-based estimator. Every other family (and the fallback)
 * uses `CharBasedTokenizer`.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveFamily } from "./model-family";

export interface Tokenizer {
  /** Count tokens in text. */
  count(text: string): number;
  /** Which model family this tokenizer handles. */
  modelFamily: string;
}

// ---------------------------------------------------------------------------
// Fallback observability (T-2)
// ---------------------------------------------------------------------------
//
// Silently degrading a real vendor tokenizer to the character estimator makes
// every downstream budget number wrong by ~10% with no signal. We keep a
// process-wide counter of how often that happened and warn exactly once per
// family so the first degradation is visible in logs without spamming.

let charEstimatorFallbacks = 0;
const warnedFamilies = new Set<string>();

/** How many times a real tokenizer fell back to the character estimator. */
export function getCharEstimatorFallbackCount(): number {
  return charEstimatorFallbacks;
}

/** Test seam: reset the fallback counter and warn-once memory. */
export function resetTokenizerFallbackStats(): void {
  charEstimatorFallbacks = 0;
  warnedFamilies.clear();
}

function recordFallback(family: string, reason: string): void {
  charEstimatorFallbacks += 1;
  if (!warnedFamilies.has(family)) {
    warnedFamilies.add(family);
    // One-time degradation signal; there is no telemetry hook wired into
    // this leaf package (console.warn is permitted by the lint config).
    console.warn(
      `[engram/tokenizer] ${family} tokenizer unavailable (${reason}); ` +
        `falling back to character estimate — token budgets are approximate.`,
    );
  }
}

/**
 * Simple character-based token estimator.
 * Accurate to ~10% for English text. Used as the default when no
 * model-specific tokenizer is available, and as the fallback when a real
 * vendor tokenizer cannot be loaded or throws.
 *
 * Rule of thumb: 1 token ≈ 4 characters for English,
 * 1 token ≈ 3.5 characters for code.
 */
export class CharBasedTokenizer implements Tokenizer {
  readonly modelFamily = "estimate";
  private readonly charsPerToken: number;

  constructor(charsPerToken = 3.8) {
    this.charsPerToken = charsPerToken;
  }

  count(text: string): number {
    return Math.max(1, Math.ceil(text.length / this.charsPerToken));
  }
}

// ---------------------------------------------------------------------------
// Real vendor tokenizers — lazily loaded WASM.
// ---------------------------------------------------------------------------

/** Minimal structural view of a tiktoken encoder — `.encode()` → array-like. */
export interface TokenEncoder {
  encode(text: string): { readonly length: number };
}

/** Loads a tiktoken encoder for a given model id. May throw (missing dep/WASM). */
export type TiktokenEncoderLoader = (modelId: string) => TokenEncoder;
/** Loads a `(text) => tokenCount` function. May throw (missing dep/WASM). */
export type TokenCounterLoader = () => (text: string) => number;

// `createRequire` (not `await import`) because the Tokenizer.count() contract is
// synchronous — a dynamic import() would force count() async, changing the
// interface. require() still loads the WASM lazily on first invocation of the
// loader (i.e. first count() of that family), never at module evaluation.
//
// The requirer itself is built LAZILY and defensively. When this module is
// bundled to CJS (esbuild for the Vercel API function), `import.meta.url`
// collapses to `undefined`, and `createRequire(undefined)` throws
// ERR_INVALID_ARG_VALUE. Doing that at module top-level would crash the entire
// serverless function at cold boot — taking down every route, not just token
// counting. So we defer construction to first use, guard `import.meta.url`, and
// fall back to `__filename` (present in the CJS bundle) and finally the process
// cwd, mirroring packages/code-graph/src/loader.ts's `moduleRequire()`.
let cachedRequire: ReturnType<typeof createRequire> | null = null;
function nodeRequire(id: string): unknown {
  if (!cachedRequire) {
    let base: string;
    if (typeof import.meta.url === "string" && import.meta.url.length > 0) {
      base = import.meta.url;
    } else if (typeof __filename === "string" && __filename.length > 0) {
      base = __filename;
    } else {
      // Last resort: resolve packages relative to the process working directory
      // so a missing module URL degrades to a normal require, never a boot crash.
      base = pathToFileURL(`${process.cwd()}/`).href;
    }
    cachedRequire = createRequire(base);
  }
  return cachedRequire(id);
}

/** Minimal typed views of the vendor modules (avoid `any` at the require seam). */
interface TiktokenModule {
  get_encoding(encoding: string): TokenEncoder;
}
interface AnthropicTokenizerModule {
  countTokens(text: string): number;
}

/**
 * Choose the tiktoken encoding for an OpenAI model id.
 *
 * `cl100k_base` covers only the original GPT-3.5 / GPT-4 line (`gpt-3.5-turbo`,
 * `gpt-4`, `gpt-4-turbo`). Everything newer — `gpt-4o`, the dotted `gpt-4.x`
 * refreshes (`gpt-4.1`, `gpt-4.5`), GPT-5, and the `o1`/`o3`/`o4` reasoning
 * line — uses `o200k_base`. Matching a bare `gpt-4` prefix without excluding the
 * dotted refreshes would bill `gpt-4.1` against the wrong vocabulary and skew
 * every budget number for that model.
 */
const OPENAI_O200K_GPT4 = /gpt-4(o|\.\d)/;

function openAiEncodingFor(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (
    (lower.includes("gpt-3.5") || lower.includes("gpt-4")) &&
    !OPENAI_O200K_GPT4.test(lower)
  ) {
    return "cl100k_base";
  }
  return "o200k_base";
}

const defaultTiktokenLoader: TiktokenEncoderLoader = (modelId) => {
  const mod = nodeRequire("tiktoken") as TiktokenModule;
  return mod.get_encoding(openAiEncodingFor(modelId));
};

const defaultAnthropicLoader: TokenCounterLoader = () => {
  const mod = nodeRequire(
    "@anthropic-ai/tokenizer",
  ) as AnthropicTokenizerModule;
  return mod.countTokens;
};

/**
 * OpenAI-family tokenizer backed by `tiktoken`. The encoder is loaded lazily on
 * the first `count()` and memoized; if the load or an individual encode throws,
 * it permanently falls back to a character-based estimate (4.0 chars/token,
 * cl100k/o200k's rough ratio) so token budgeting never crashes.
 */
export class TiktokenTokenizer implements Tokenizer {
  readonly modelFamily = "openai";
  private encoder: TokenEncoder | null = null;
  private loadFailed = false;
  private readonly fallback = new CharBasedTokenizer(4.0);

  constructor(
    private readonly modelId: string,
    private readonly load: TiktokenEncoderLoader = defaultTiktokenLoader,
  ) {}

  count(text: string): number {
    if (!this.encoder && !this.loadFailed) {
      try {
        this.encoder = this.load(this.modelId);
      } catch (err) {
        // Dep unavailable or WASM init failed — degrade to the estimator for
        // the lifetime of this (cached) tokenizer, but surface it once.
        this.loadFailed = true;
        recordFallback(
          "openai",
          err instanceof Error ? err.message : "load failed",
        );
      }
    }
    if (this.encoder) {
      try {
        return this.encoder.encode(text).length;
      } catch (err) {
        // A per-call encode failure shouldn't crash budgeting; fall back.
        this.loadFailed = true;
        this.encoder = null;
        recordFallback(
          "openai",
          err instanceof Error ? err.message : "encode failed",
        );
      }
    }
    return this.fallback.count(text);
  }
}

/**
 * Anthropic-family tokenizer backed by `@anthropic-ai/tokenizer`. Same lazy,
 * memoized, fail-safe strategy as {@link TiktokenTokenizer}; fallback estimator
 * uses 3.5 chars/token (Claude packs slightly denser than GPT).
 */
export class AnthropicTokenizer implements Tokenizer {
  readonly modelFamily = "anthropic";
  private counter: ((text: string) => number) | null = null;
  private loadFailed = false;
  private readonly fallback = new CharBasedTokenizer(3.5);

  constructor(
    private readonly load: TokenCounterLoader = defaultAnthropicLoader,
  ) {}

  count(text: string): number {
    if (!this.counter && !this.loadFailed) {
      try {
        this.counter = this.load();
      } catch (err) {
        this.loadFailed = true;
        recordFallback(
          "anthropic",
          err instanceof Error ? err.message : "load failed",
        );
      }
    }
    if (this.counter) {
      try {
        return this.counter(text);
      } catch (err) {
        this.loadFailed = true;
        this.counter = null;
        recordFallback(
          "anthropic",
          err instanceof Error ? err.message : "count failed",
        );
      }
    }
    return this.fallback.count(text);
  }
}

/** Singleton tokenizer instances, cached by encoding key. */
const cache = new Map<string, Tokenizer>();

/**
 * Get a tokenizer for the given model ID. Routes by model family:
 *   - `openai`    → `tiktoken` (o200k_base / cl100k_base per model)
 *   - `anthropic` → `@anthropic-ai/tokenizer`
 *   - everything else → character-based estimator
 * Real tokenizers load their WASM lazily on first `count()`, and fall back to
 * the estimator on any failure.
 */
export function getTokenizer(modelId: string): Tokenizer {
  const family = resolveFamily(modelId);
  // OpenAI encoding varies by model, so key the cache on the resolved encoding
  // rather than the bare family; other families have a single tokenizer each.
  const cacheKey =
    family === "openai" ? `openai:${openAiEncodingFor(modelId)}` : family;

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let tokenizer: Tokenizer;
  switch (family) {
    case "openai":
      tokenizer = new TiktokenTokenizer(modelId);
      break;
    case "anthropic":
      tokenizer = new AnthropicTokenizer();
      break;
    default:
      // google + everything unrecognized: ~3.8 chars/token estimate.
      tokenizer = new CharBasedTokenizer(3.8);
  }

  cache.set(cacheKey, tokenizer);
  return tokenizer;
}

/**
 * Count tokens in text for a given model. Convenience wrapper.
 */
export function countTokens(text: string, modelId: string): number {
  return getTokenizer(modelId).count(text);
}
