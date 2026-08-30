/**
 * On-device `AgentAi` adapter — runs the coding engine on the LOCAL GGUF
 * coordinator instead of the metered platform gateway.
 *
 * This is the "local" side of the REPL's `/coordinator remote|local` toggle.
 * Where {@link createPlatformAgentAi} routes every turn through the platform
 * endpoint (metered, credit-charged), this adapter drives the in-process GGUF
 * runtime the developer downloaded with `oxagen models pull` — fully offline,
 * zero provider cost, no token leaves the machine.
 *
 * The engine speaks the AI SDK's `streamText`/`generateObject` protocol, so we
 * wrap the runtime in a spec-correct {@link createOnDeviceLanguageModel} (which
 * teaches the local model tool-calling via a prompt convention) and hand it to
 * the same SDK entrypoints the platform adapter uses. The engine's tool loop is
 * therefore identical across remote and local — only the backing model differs.
 */
import type {
  AgentAi,
  ModelRunArgs,
  ObjectRunArgs,
  ObjectRunResult,
} from "@oxagen/agent-engine";
import { streamText, generateObject } from "ai";
import { OnDeviceProvider } from "../../runtime/providers/on-device.js";
import {
  buildProvider,
  ON_DEVICE_ID,
} from "../../runtime/providers/factory.js";
import {
  createOnDeviceLanguageModel,
  type OnDeviceComplete,
} from "../../runtime/providers/on-device-language-model.js";
import type { ProgressFn } from "../../runtime/provisioning/download.js";
import { debugLog } from "../../lib/debug-log.js";

export interface OnDeviceCoordinator {
  /** The `AgentAi` port the engine runs on. */
  ai: AgentAi;
  /** The resolved on-device model id (e.g. "qwen3-coder-30b-a3b-instruct"). */
  modelId: string;
  /** Release the loaded weights (frees RAM) when switching back to remote. */
  dispose: () => Promise<void>;
}

export interface PrepareOnDeviceOptions {
  /** Injectable provider, chiefly for tests. Defaults to a real one. */
  provider?: OnDeviceProvider;
  /** Download/prepare progress (surfaced in the REPL while weights fetch). */
  onProgress?: ProgressFn;
}

/**
 * Prepare the local coordinator: ensure the resolved model fits, its runtime is
 * installed, and its weights are cached (downloading when auto-download is on),
 * then build the `AgentAi` over it.
 *
 * Throws the runtime's typed, actionable errors ({@link OptionalDepMissingError},
 * {@link NoFittingModelError}, {@link AutoDownloadDisabledError}) so the caller
 * can tell the developer exactly how to unblock — this never silently falls back
 * to a cloud model.
 */
export async function prepareOnDeviceCoordinator(
  opts: PrepareOnDeviceOptions = {},
): Promise<OnDeviceCoordinator> {
  // Route the default construction through the runtime factory so buildProvider
  // is the single live seam for coordinator resolution (ON_DEVICE_ID always
  // yields an OnDeviceProvider — the cast is exact). An injected provider (the
  // coordinator seam / tests) wins.
  const provider =
    opts.provider ?? (buildProvider(ON_DEVICE_ID) as OnDeviceProvider);

  // Fail fast with a typed error (dep missing / nothing fits / not cached) and
  // stream download progress before we ever start a turn.
  await provider.ensureReady(opts.onProgress);

  const complete: OnDeviceComplete = async (req) => {
    const res = await provider.complete({
      messages: req.messages,
      ...(req.maxOutputTokens !== undefined
        ? { maxOutputTokens: req.maxOutputTokens }
        : {}),
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
      ...(req.effort ? { effort: req.effort } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    });
    return { text: res.text, usage: res.usage };
  };

  const modelId = provider.id();
  const model = createOnDeviceLanguageModel({ modelId, complete });

  const ai: AgentAi = {
    stream(args: ModelRunArgs) {
      void debugLog("llm", "llm.stream.request.ondevice", {
        model: modelId,
        messageCount: Array.isArray(args.messages) ? args.messages.length : 0,
        toolNames: args.tools ? Object.keys(args.tools) : [],
      });
      return streamText({
        model,
        system: args.system,
        messages: args.messages,
        tools: args.tools,
        stopWhen: args.stopWhen,
        abortSignal: args.abortSignal,
        // The local language model reads effort from providerOptions.oxagen.effort.
        ...(args.effort
          ? { providerOptions: { oxagen: { effort: args.effort } } }
          : {}),
        onError: args.onError,
        onStepFinish: args.onStepFinish
          ? (step) =>
              args.onStepFinish?.({
                toolCalls: step.toolCalls,
                toolResults: step.toolResults,
              })
          : undefined,
      });
    },

    async generateObject<T>(
      args: ObjectRunArgs<T>,
    ): Promise<ObjectRunResult<T>> {
      const common = {
        model,
        schema: args.schema,
        system: args.system,
        abortSignal: args.abortSignal,
      };
      void debugLog("llm", "llm.object.request.ondevice", { model: modelId });
      const result = args.messages
        ? await generateObject({ ...common, messages: args.messages })
        : await generateObject({ ...common, prompt: args.prompt ?? "" });
      return {
        object: result.object,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          // AI SDK v7 nests cache reads under `inputTokenDetails`; flatten to
          // match StreamRunResult's usage (see engine.ts) so evaluator/judge
          // calls price their cache reads the same way worker steps do.
          cachedInputTokens:
            result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        },
      };
    },
  };

  return { ai, modelId, dispose: () => provider.dispose() };
}
