/**
 * On-device model resolver.
 *
 * Requirement 3: pick "most capable" from a scored capability table, not a
 * hard-coded name. The rule (mirrors `models.json -> onDeviceProvisioning`):
 * pick the model with the highest codeScore that fits the device at the best
 * available quantization in the preference order. `modelId = "auto"` uses this;
 * a pinned `modelId` selects that specific row (still fitting it to a quant).
 *
 * "Best quantization" = the highest-quality entry in `quantizationPreference`
 * (q8 → q4) that the model ships AND that fits the device's memory budget. We
 * prefer quality, then fall back down the ladder until something fits.
 */
import { estimateModelRamGB, fitsDevice } from "./device.js";
import { capabilityTable, capabilityRow } from "./registry.js";
import type { CapabilityRow, DeviceProfile, Quantization } from "./types.js";

/** A resolved on-device pick: which model, at which quantization, and why. */
export interface ResolvedOnDevice {
  row: CapabilityRow;
  quant: Quantization;
  /** Estimated resident RAM (GB) for the chosen model+quant. */
  estRamGB: number;
  /** One-line, human-readable rationale for `models` output + logs. */
  rationale: string;
}

/** Why no on-device model could be resolved for a device. */
export interface UnresolvedOnDevice {
  row: null;
  quant: null;
  estRamGB: null;
  /** Plain-language explanation, e.g. "no model fits 8 GB of RAM". */
  rationale: string;
}

export type ResolveResult = ResolvedOnDevice | UnresolvedOnDevice;

/**
 * Choose the most-preferred quantization a model ships that fits the device.
 * Preference is ordered best-quality-first (q8…q4); we walk it and return the
 * first quant the row offers and the device can hold. Undefined = nothing fits.
 */
export function bestFittingQuant(
  device: DeviceProfile,
  row: CapabilityRow,
  quantPref: Quantization[],
): Quantization | undefined {
  for (const quant of quantPref) {
    if (!row.quantizations.includes(quant)) continue;
    if (fitsDevice(device, row.params, quant)) return quant;
  }
  return undefined;
}

/**
 * Resolve the best on-device code model for a device.
 *
 * @param device     the host compute budget.
 * @param quantPref  quantization preference, best quality first.
 * @param modelId    "auto" (default) resolves by score; any other value pins
 *                   that specific row.
 * @param table      the capability table (defaults to the registry, sorted by
 *                   codeScore desc). Injectable for tests.
 */
export function resolveBestOnDeviceModel(
  device: DeviceProfile,
  quantPref: Quantization[],
  modelId = "auto",
  table: CapabilityRow[] = capabilityTable(),
): ResolveResult {
  // Sort defensively: callers may pass an unsorted table.
  const rows = [...table].sort((a, b) => b.codeScore - a.codeScore);

  if (modelId !== "auto") {
    const pinned =
      capabilityRow(modelId) ?? rows.find((r) => r.modelId === modelId);
    if (!pinned) {
      return unresolved(
        `pinned model "${modelId}" is not in the capability table`,
      );
    }
    const quant = bestFittingQuant(device, pinned, quantPref);
    if (!quant) {
      return unresolved(
        `pinned model "${modelId}" needs more memory than this device offers ` +
          `(smallest quant ~${smallestRamGB(pinned, quantPref)} GB)`,
      );
    }
    return resolved(pinned, quant, `pinned model "${modelId}" at ${quant}`);
  }

  for (const row of rows) {
    const quant = bestFittingQuant(device, row, quantPref);
    if (quant) {
      return resolved(
        row,
        quant,
        `highest-scoring model that fits (codeScore ${row.codeScore}, ${quant})`,
      );
    }
  }

  return unresolved(
    `no on-device model in the capability table fits this device ` +
      `(~${round1(memoryBudgetLabel(device))} GB usable)`,
  );
}

function resolved(
  row: CapabilityRow,
  quant: Quantization,
  rationale: string,
): ResolvedOnDevice {
  return {
    row,
    quant,
    estRamGB: estimateModelRamGB(row.params, quant),
    rationale,
  };
}

function unresolved(rationale: string): UnresolvedOnDevice {
  return { row: null, quant: null, estRamGB: null, rationale };
}

/** Smallest RAM (GB) any preferred quant of a row would need — for messaging. */
function smallestRamGB(row: CapabilityRow, quantPref: Quantization[]): number {
  const supported = quantPref.filter((q) => row.quantizations.includes(q));
  const estimates = supported.map((q) => estimateModelRamGB(row.params, q));
  return estimates.length ? Math.min(...estimates) : row.minRamGB;
}

function memoryBudgetLabel(device: DeviceProfile): number {
  return device.unifiedMemory
    ? Math.max(device.ramGB * 0.7, device.vramGB)
    : device.vramGB > 0
      ? device.vramGB
      : device.ramGB * 0.65;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
