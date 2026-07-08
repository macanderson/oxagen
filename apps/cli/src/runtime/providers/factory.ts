/**
 * Provider factory + registry role helpers.
 *
 * This is the seam Group 2's orchestrator uses: give it a model id (or a role)
 * and it hands back a {@link ModelProvider}, on-device or cloud, all behind the
 * one interface. Roles (coordinator / worker / judge) resolve through the
 * registry so routing policy stays data-driven.
 */
import { cloudModel, cloudModelIds, roles } from "../registry.js";
import { getCoordinator } from "../config.js";
import {
  AnthropicProvider,
  OpenAiProvider,
  type CloudProviderDeps,
} from "./cloud.js";
import { OnDeviceProvider, type OnDeviceProviderDeps } from "./on-device.js";
import type { ModelProvider } from "../types.js";

/** Injectable deps threaded to whichever concrete provider is built. */
export interface BuildDeps {
  onDevice?: OnDeviceProviderDeps;
  cloud?: CloudProviderDeps;
}

/** The special id for the local coordinator. */
export const ON_DEVICE_ID = "on-device";

/** Build a provider for a model id ("on-device" or a cloud registry id). */
export function buildProvider(id: string, deps: BuildDeps = {}): ModelProvider {
  if (id === ON_DEVICE_ID) return new OnDeviceProvider(deps.onDevice);
  const entry = cloudModel(id);
  if (!entry) {
    throw new Error(
      `Unknown model id "${id}". Known ids: ${ON_DEVICE_ID}, ${cloudModelIds().join(", ")}.`,
    );
  }
  return entry.vendor === "openai"
    ? new OpenAiProvider(id, entry, deps.cloud)
    : new AnthropicProvider(id, entry, deps.cloud);
}

/**
 * The coordinator provider (requirement 2). Defaults to on-device; the developer
 * may pin any coordinator candidate. Never silently swapped for a cloud model —
 * an on-device coordinator that can't serve throws so the caller can offer help.
 */
export function coordinatorProvider(deps: BuildDeps = {}): ModelProvider {
  return buildProvider(getCoordinator(), deps);
}

/** The default worker provider for code tasks (registry `workerModels`). */
export function workerProvider(
  role: "defaultCode" | "cheapBasic" = "defaultCode",
  deps: BuildDeps = {},
): ModelProvider {
  return buildProvider(roles().workerModels[role], deps);
}

/** The judge provider (registry `judgeModels.default` — a different vendor). */
export function judgeProvider(deps: BuildDeps = {}): ModelProvider {
  return buildProvider(roles().judgeModels.default, deps);
}
