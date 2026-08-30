/**
 * The optional on-device inference runtime.
 *
 * Requirement 1 & 2: the on-device runtime ships as an OPTIONAL dependency
 * (`node-llama-cpp`, declared in `optionalDependencies`). The CLI installs and
 * runs perfectly without it; we only touch it when the developer opts into an
 * on-device coordinator. So it is *never* imported statically — every access
 * goes through {@link loadOptionalRuntime}, a guarded dynamic import that
 * resolves to `null` when the package is absent. A non-literal specifier keeps
 * both `tsc` and the esbuild bundle from trying to resolve an optional native
 * module at build time.
 *
 * The concrete llama.cpp API is wrapped behind {@link OnDeviceRuntime} so the
 * providers and their tests depend on our small interface, not on
 * `node-llama-cpp` internals.
 */
import type { CompletionRequest, CompletionUsage } from "../types.js";

/** A model loaded into memory and ready to generate. */
export interface LoadedModel {
  complete(
    req: CompletionRequest,
  ): Promise<{ text: string; usage: CompletionUsage }>;
  dispose(): Promise<void>;
}

/** The optional runtime: loads a cached GGUF file into a {@link LoadedModel}. */
export interface OnDeviceRuntime {
  /** Human label of the backend, e.g. "node-llama-cpp". */
  readonly name: string;
  load(modelPath: string): Promise<LoadedModel>;
}

/** The optional package name — the one dependency the CLI can run without. */
export const OPTIONAL_DEP = "node-llama-cpp";

/** Flatten chat messages into a single prompt for a single-turn completion. */
function renderPrompt(req: CompletionRequest): {
  system?: string;
  prompt: string;
} {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const prompt = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => m.content)
    .join("\n\n");
  return { ...(system ? { system } : {}), prompt };
}

/**
 * Load the optional runtime, or return `null` if it is not installed.
 *
 * `loader` is injectable so tests can simulate both "installed" and "absent"
 * without the native package. The default performs a guarded dynamic import.
 */
export async function loadOptionalRuntime(
  loader: () => Promise<unknown> = defaultLoader,
): Promise<OnDeviceRuntime | null> {
  let mod: LlamaModule | null;
  try {
    mod = (await loader()) as LlamaModule | null;
  } catch {
    // Not installed, or failed to load its native binding. Either way the CLI
    // stays fully functional; the caller offers to install it.
    return null;
  }
  if (!mod || typeof mod.getLlama !== "function") return null;
  return adaptLlama(mod);
}

/** True when the optional dependency is importable on this machine. */
export async function isOptionalDepInstalled(
  loader: () => Promise<unknown> = defaultLoader,
): Promise<boolean> {
  return (await loadOptionalRuntime(loader)) !== null;
}

// ── node-llama-cpp adapter ───────────────────────────────────────────────────
// Typed structurally against the subset of the v3 API we use, so we never import
// the package's types (it may be absent). See https://node-llama-cpp.withcat.ai.

interface LlamaChatSessionCtor {
  new (opts: {
    contextSequence: unknown;
  }): {
    prompt(
      text: string,
      opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
    ): Promise<string>;
  };
}

interface LlamaModule {
  getLlama(): Promise<{
    loadModel(opts: { modelPath: string }): Promise<{
      tokenize(text: string): { length: number };
      createContext(): Promise<{ getSequence(): unknown }>;
      dispose?(): Promise<void>;
    }>;
  }>;
  LlamaChatSession: LlamaChatSessionCtor;
}

function adaptLlama(mod: LlamaModule): OnDeviceRuntime {
  return {
    name: OPTIONAL_DEP,
    async load(modelPath: string): Promise<LoadedModel> {
      const llama = await mod.getLlama();
      const model = await llama.loadModel({ modelPath });
      const context = await model.createContext();
      const session = new mod.LlamaChatSession({
        contextSequence: context.getSequence(),
      });

      return {
        async complete(req: CompletionRequest) {
          const { prompt } = renderPrompt(req);
          const text = await session.prompt(prompt, {
            ...(req.maxOutputTokens !== undefined
              ? { maxTokens: req.maxOutputTokens }
              : {}),
            ...(req.temperature !== undefined
              ? { temperature: req.temperature }
              : {}),
            ...(req.signal ? { signal: req.signal } : {}),
          });
          return {
            text,
            usage: {
              inputTokens: model.tokenize(prompt).length,
              outputTokens: model.tokenize(text).length,
            },
          };
        },
        async dispose() {
          await model.dispose?.();
        },
      };
    },
  };
}

/** The real dynamic import, hidden behind a non-literal specifier. */
async function defaultLoader(): Promise<unknown> {
  const specifier = OPTIONAL_DEP;
  return import(specifier);
}
