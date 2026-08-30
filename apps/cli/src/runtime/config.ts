/**
 * Typed accessors for the model-runtime config keys (deliverable 5).
 *
 * Precedence: user config (`~/.config/oxagen/config.json` under `runtime`) →
 * the baked-in defaults in `models.json`. Three keys additionally take an env
 * override ahead of both — `OXAGEN_COORDINATOR`, `OXAGEN_ONDEVICE_MODEL`, and
 * `OXAGEN_MODELS_CACHE_DIR`; the rest (auto-download, checksum verification,
 * quantization preference) are config-only. Keeping the fallbacks in the
 * registry means the shipped defaults live next to the capability table, not
 * scattered through code.
 *
 * Requirement 2: on-device is *always* a valid coordinator — nothing here ever
 * rewrites the coordinator to a cloud model. The provider layer decides whether
 * to offer a download; it never silently switches.
 */
import { readConfig, writeConfig, type RuntimeConfig } from "../lib/config.js";
import { expandHome, registryDefaults } from "./registry.js";
import type { Quantization } from "./types.js";

function cfg(): RuntimeConfig {
  return readConfig().runtime ?? {};
}

/** The coordinator model id: "on-device" (default) or a cloud id like "haiku". */
export function getCoordinator(): string {
  return (
    process.env["OXAGEN_COORDINATOR"] ??
    cfg().coordinator ??
    registryDefaults().coordinator
  );
}

/** Whether to auto-download the on-device model on first coordinator use. */
export function getAutoDownload(): boolean {
  return (
    cfg().onDevice?.autoDownload ?? registryDefaults().onDevice.autoDownload
  );
}

/** The on-device model id: "auto" (resolve best) or a pinned modelId. */
export function getOnDeviceModelId(): string {
  return (
    process.env["OXAGEN_ONDEVICE_MODEL"] ??
    cfg().onDevice?.modelId ??
    registryDefaults().onDevice.modelId
  );
}

/** Absolute weights cache directory. */
export function getCacheDir(): string {
  return expandHome(
    process.env["OXAGEN_MODELS_CACHE_DIR"] ??
      cfg().onDevice?.cacheDir ??
      registryDefaults().onDevice.cacheDir,
  );
}

/** Whether downloads are checksum-verified before caching. */
export function getVerifyChecksum(): boolean {
  return (
    cfg().onDevice?.verifyChecksum ?? registryDefaults().onDevice.verifyChecksum
  );
}

/** Quantization preference, best quality first. */
export function getQuantizationPreference(): Quantization[] {
  return (
    cfg().onDevice?.quantizationPreference ??
    registryDefaults().onDevice.quantizationPreference
  );
}

/** Persist the coordinator choice. Requirement 2: any id is allowed, on-device included. */
export function setCoordinator(coordinator: string): void {
  const current = cfg();
  writeConfig({ runtime: { ...current, coordinator } });
}

/** Merge a patch into the on-device config block. */
export function setOnDeviceConfig(
  patch: NonNullable<RuntimeConfig["onDevice"]>,
): void {
  const current = cfg();
  writeConfig({
    runtime: { ...current, onDevice: { ...current.onDevice, ...patch } },
  });
}
