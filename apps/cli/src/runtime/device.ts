/**
 * Device profiling + on-device memory fit.
 *
 * Requirement 5: respect device limits. We detect RAM, GPU/VRAM, and CPU cores,
 * then estimate how much memory a given model+quantization actually needs so the
 * resolver can pick something that fits. Detection is best-effort and fully
 * injectable (see {@link DetectDeps}) so tests can pin an exact device profile
 * without touching the host.
 *
 * VRAM is deliberately conservative: cross-platform dedicated-VRAM detection is
 * unreliable, so we only claim GPU memory when we can reason about it — Apple
 * Silicon unified memory (GPU shares system RAM). Everything else reports 0 VRAM
 * and the fit falls back to system RAM (CPU inference via llama.cpp still works).
 */
import { arch, cpus, platform, totalmem } from "node:os";
import type { DeviceProfile, Quantization } from "./types.js";

const GB = 1024 ** 3;

/** Injectable host probes, so device detection is deterministic under test. */
export interface DetectDeps {
  totalmemBytes: () => number;
  cpuCount: () => number;
  platform: () => NodeJS.Platform;
  arch: () => string;
}

const defaultDeps: DetectDeps = {
  totalmemBytes: () => totalmem(),
  cpuCount: () => cpus().length,
  platform: () => platform(),
  arch: () => arch(),
};

/**
 * Detect the current device's compute budget. Apple Silicon is treated as
 * unified memory: the GPU (Metal) can address a large fraction of system RAM,
 * so we surface a usable VRAM figure rather than 0. On other platforms we do not
 * guess dedicated VRAM (it needs vendor tooling we don't want to shell out to);
 * the fit then uses system RAM, which is the safe lower bound.
 */
export function detectDevice(deps: DetectDeps = defaultDeps): DeviceProfile {
  const ramGB = round1(deps.totalmemBytes() / GB);
  const cpuCores = Math.max(1, deps.cpuCount());
  const isAppleSilicon =
    deps.platform() === "darwin" && deps.arch() === "arm64";

  if (isAppleSilicon) {
    // Metal on unified memory. macOS lets the GPU address roughly ~70% of RAM
    // for large allocations; use that as a conservative usable-VRAM figure.
    return {
      ramGB,
      vramGB: round1(ramGB * 0.7),
      gpu: "metal",
      cpuCores,
      unifiedMemory: true,
    };
  }

  return { ramGB, vramGB: 0, gpu: null, cpuCores, unifiedMemory: false };
}

/** Approx bytes-per-weight (incl. GGUF K-quant overhead) for each quantization. */
const BITS_PER_WEIGHT: Record<Quantization, number> = {
  q4: 4.7,
  q5: 5.6,
  q6: 6.6,
  q8: 8.5,
};

/** Fixed runtime + KV-cache headroom (GB) on top of the resident weights. */
const RUNTIME_OVERHEAD_GB = 1.8;

/**
 * Parse a params label ("32B", "30B-A3B", "7B") into billions of *resident*
 * parameters. For MoE labels ("30B-A3B" = 30B total, 3B active) the resident
 * weight count is the total (all experts sit in memory), so we take the first
 * number — that is what actually consumes RAM.
 */
export function paramsBillions(params: string): number {
  const match = params.match(/([\d.]+)\s*b/i);
  return match ? Number(match[1]) : 0;
}

/**
 * Estimate the RAM (GB) a model needs at a given quantization: resident weights
 * plus a fixed runtime/KV overhead. Used both for the fit check and for the
 * `models status` device-fit column.
 */
export function estimateModelRamGB(
  params: string,
  quant: Quantization,
): number {
  const billions = paramsBillions(params);
  const weightsGB = (billions * 1e9 * (BITS_PER_WEIGHT[quant] / 8)) / GB;
  return round1(weightsGB + RUNTIME_OVERHEAD_GB);
}

/**
 * The memory budget a model may occupy on this device. On unified-memory GPUs
 * the larger of RAM-headroom and VRAM applies; on CPU-only hosts we reserve a
 * slice of RAM for the OS and everything else.
 */
export function memoryBudgetGB(device: DeviceProfile): number {
  if (device.unifiedMemory)
    return round1(Math.max(device.ramGB * 0.7, device.vramGB));
  if (device.vramGB > 0) return device.vramGB;
  // CPU-only: leave ~35% of RAM for the OS, editor, and the CLI itself.
  return round1(device.ramGB * 0.65);
}

/** Does a model+quantization fit this device's memory budget? */
export function fitsDevice(
  device: DeviceProfile,
  params: string,
  quant: Quantization,
): boolean {
  return estimateModelRamGB(params, quant) <= memoryBudgetGB(device);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
