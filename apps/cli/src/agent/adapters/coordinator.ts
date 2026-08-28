/**
 * The coordinator resolution seam — the ONE place a role (the turn's coordinator
 * "port") is resolved through the runtime {@link buildProvider} factory into an
 * engine-consumable {@link AgentAi}.
 *
 * ## Why this exists / the real shape of the wiring
 *
 * The engine consumes a single {@link AgentAi} port (`stream` + `generateObject`)
 * and per-role model *slugs*; a cloud model streams natively through the gateway
 * (tools + streaming intact). The runtime's {@link ModelProvider} abstraction,
 * by contrast, bundles model **and transport** and exposes a single-shot
 * `complete()`. Routing native cloud streaming through `complete()` would strip
 * tool-calling — a regression — so the factory's live role is
 * *transport/coordinator selection*, not re-implementing the streaming path:
 *
 *   - **on-device coordinator** — the transport genuinely differs (a local GGUF
 *     runtime, not the gateway), so the factory's {@link OnDeviceProvider} is
 *     bridged into the engine by {@link prepareOnDeviceCoordinator} (the proven
 *     `on-device-agent-ai.ts` adapter: `complete` → AI-SDK LanguageModel → AgentAi).
 *   - **cloud coordinator** — the transport is the same gateway the shared
 *     metered port already speaks. The cloud {@link GatewayCloudProvider}
 *     resolves the concrete slug + availability (and, for BYOK, a credential
 *     preflight); the engine then streams that slug through the caller's already
 *     metered port. No behavior/metering/BYOK change, native tools preserved.
 *
 * This makes {@link buildProvider} (and the concrete cloud/on-device providers)
 * the single live routing seam, so a future free local provider (Ollama / ONNX)
 * drops in as a new {@link ModelProvider} behind the factory with no caller
 * change — instead of a second parallel model-resolution path.
 *
 * The cloud provider's `complete()` is kept metering-accurate via
 * {@link meteredCloudGenerate}: any completion runs over the SAME metered port
 * (`createMeteredAi`/the gateway) rather than a raw `ai` call.
 */
import { stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import type { AgentAi } from "@oxagen/agent-engine";
import {
  buildProvider,
  type BuildDeps,
} from "../../runtime/providers/factory.js";
import {
  GatewayCloudProvider,
  type GenerateFn,
} from "../../runtime/providers/cloud.js";
import type { OnDeviceProvider } from "../../runtime/providers/on-device.js";
import { getCoordinator } from "../../runtime/config.js";
import type { ModelKind, ModelProvider } from "../../runtime/types.js";
import type { ProgressFn } from "../../runtime/provisioning/download.js";
import { prepareOnDeviceCoordinator } from "./on-device-agent-ai.js";

/**
 * Adapt a metered {@link AgentAi} into the cloud provider's {@link GenerateFn}
 * so a cloud `complete()` runs over the SAME metered streaming path the engine
 * worker uses — metrics emit, cache reads are priced, BYOK/gateway auth applies.
 * The provider's single-shot request is served by a bounded one-step stream.
 */
export function meteredCloudGenerate(base: AgentAi): GenerateFn {
  return async (args) => {
    // The cloud request carries its system prompt as system-role message(s); the
    // engine port takes `system` separately, so split them back out.
    const system = args.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const messages: ModelMessage[] = args.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }) as ModelMessage);

    const result = base.stream({
      model: args.model,
      system,
      messages,
      tools: {},
      stopWhen: stepCountIs(1),
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    });
    const [text, usage] = await Promise.all([result.text, result.usage]);
    return {
      text,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    };
  };
}

/** A coordinator resolved to its engine-consumable port + concrete model id. */
export interface ResolvedCoordinator {
  /** The engine port for the turn (native metered gateway/platform, or on-device). */
  ai: AgentAi;
  /** Concrete model slug/id the coordinator runs (cloud slug, or on-device model id). */
  modelId: string;
  kind: ModelKind;
  /** Release on-device weights when switching away. Absent for cloud. */
  dispose?: () => Promise<void>;
}

export interface ResolveCoordinatorOptions {
  /**
   * The already-built, metered remote port (platform-metered for a real session,
   * gateway-direct for BYOK/bench). Used as-is when the coordinator is cloud.
   */
  baseAi: AgentAi;
  /** Coordinator model id ("on-device" or a cloud registry id). Default {@link getCoordinator}. */
  coordinatorId?: string;
  /** On-device weight-download progress (surfaced while the model fetches). */
  onProgress?: ProgressFn;
  /**
   * Cloud only: verify a usable BYOK/gateway credential resolves before the turn
   * (throws the provider's typed {@link MissingCredentialError}). Leave OFF for a
   * platform-metered session — it authenticates server-side with no local key.
   */
  credentialPreflight?: boolean;
  /** Test seam: build the provider (defaults to the runtime {@link buildProvider}). */
  buildProviderImpl?: (id: string, deps: BuildDeps) => ModelProvider;
}

/**
 * Resolve the turn's coordinator through the {@link buildProvider} factory and
 * bridge it to an engine {@link AgentAi}. On-device runs fully local (the port is
 * swapped for the GGUF adapter); cloud keeps the caller's native metered port and
 * only resolves the slug/availability. See the module docblock for why.
 */
export async function resolveCoordinatorAi(
  opts: ResolveCoordinatorOptions,
): Promise<ResolvedCoordinator> {
  const id = opts.coordinatorId ?? getCoordinator();
  // Inject the metered generate so any cloud `complete()` is on the metered path.
  const deps: BuildDeps = {
    cloud: { generate: meteredCloudGenerate(opts.baseAi) },
  };
  const provider = (opts.buildProviderImpl ?? buildProvider)(id, deps);

  if (provider.kind() === "on-device") {
    // kind() === "on-device" ⇒ an OnDeviceProvider (the factory's ON_DEVICE_ID
    // branch); the adapter needs the concrete type for dispose().
    const coord = await prepareOnDeviceCoordinator({
      provider: provider as OnDeviceProvider,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
    return {
      ai: coord.ai,
      modelId: coord.modelId,
      kind: "on-device",
      dispose: coord.dispose,
    };
  }

  // Cloud coordinator: native streaming through the shared metered port; the
  // provider resolves the slug + (optionally) confirms a credential first.
  if (opts.credentialPreflight) await provider.ensureReady();
  const slug =
    provider instanceof GatewayCloudProvider ? provider.slug() : provider.id();
  return { ai: opts.baseAi, modelId: slug, kind: "cloud" };
}
