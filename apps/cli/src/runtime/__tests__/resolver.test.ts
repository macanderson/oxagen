import { describe, it, expect } from "vitest";
import { bestFittingQuant, resolveBestOnDeviceModel } from "../resolver.js";
import type { CapabilityRow, DeviceProfile, Quantization } from "../types.js";

const PREF: Quantization[] = ["q8", "q6", "q5", "q4"];

const TABLE: CapabilityRow[] = [
  // Deliberately out of order to prove the resolver sorts by codeScore.
  {
    modelId: "small-7b",
    codeScore: 0.78,
    contextWindow: 131072,
    params: "7B",
    minRamGB: 6,
    quantizations: ["q4", "q5", "q6", "q8"],
    license: "Apache-2.0",
  },
  {
    modelId: "big-32b",
    codeScore: 0.92,
    contextWindow: 131072,
    params: "32B",
    minRamGB: 22,
    quantizations: ["q4", "q5", "q6", "q8"],
    license: "Apache-2.0",
  },
  {
    modelId: "mid-14b",
    codeScore: 0.85,
    contextWindow: 131072,
    params: "14B",
    minRamGB: 10,
    quantizations: ["q4", "q5", "q6", "q8"],
    license: "Apache-2.0",
  },
];

function device(ramGB: number): DeviceProfile {
  return { ramGB, vramGB: 0, gpu: null, cpuCores: 8, unifiedMemory: false };
}

describe("resolveBestOnDeviceModel (auto)", () => {
  it("picks the highest-scoring model that fits the device", () => {
    // A big workstation: everything fits, so the top codeScore wins.
    const res = resolveBestOnDeviceModel(device(128), PREF, "auto", TABLE);
    expect(res.row?.modelId).toBe("big-32b");
    expect(res.quant).toBe("q8"); // best-quality quant that fits
  });

  it("falls to the next model down when the top one does not fit", () => {
    // 28 GB → ~18.2 GB usable: 32B (needs ≥19.3 GB) won't fit, 14B will.
    const res = resolveBestOnDeviceModel(device(28), PREF, "auto", TABLE);
    expect(res.row?.modelId).toBe("mid-14b");
  });

  it("picks the smallest model on a modest laptop", () => {
    // 12 GB → ~7.8 GB usable: only the 7B fits (at q4).
    const res = resolveBestOnDeviceModel(device(12), PREF, "auto", TABLE);
    expect(res.row?.modelId).toBe("small-7b");
    expect(res.estRamGB).not.toBeNull();
  });

  it("reports unresolved when nothing fits a tiny device", () => {
    const res = resolveBestOnDeviceModel(device(4), PREF, "auto", TABLE);
    expect(res.row).toBeNull();
    expect(res.quant).toBeNull();
    expect(res.rationale).toMatch(/no on-device model/i);
  });

  it("prefers a lower-quality quant over dropping to a weaker model", () => {
    // Enough for 32B at q4 (~20.6 GB) but not q8: still picks 32B, at q4.
    const res = resolveBestOnDeviceModel(device(34), PREF, "auto", TABLE);
    expect(res.row?.modelId).toBe("big-32b");
    expect(res.quant).toBe("q4");
  });
});

describe("resolveBestOnDeviceModel (pinned)", () => {
  it("selects the pinned model and its best fitting quant", () => {
    const res = resolveBestOnDeviceModel(device(128), PREF, "mid-14b", TABLE);
    expect(res.row?.modelId).toBe("mid-14b");
    expect(res.quant).toBe("q8");
  });

  it("errors clearly when the pinned model is unknown", () => {
    const res = resolveBestOnDeviceModel(
      device(128),
      PREF,
      "does-not-exist",
      TABLE,
    );
    expect(res.row).toBeNull();
    expect(res.rationale).toMatch(/not in the capability table/i);
  });

  it("errors clearly when the pinned model cannot fit", () => {
    const res = resolveBestOnDeviceModel(device(8), PREF, "big-32b", TABLE);
    expect(res.row).toBeNull();
    expect(res.rationale).toMatch(/more memory/i);
  });
});

describe("bestFittingQuant", () => {
  it("returns the most-preferred quant that fits", () => {
    expect(bestFittingQuant(device(128), TABLE[0]!, PREF)).toBe("q8");
    expect(bestFittingQuant(device(4), TABLE[1]!, PREF)).toBeUndefined();
  });

  it("skips quants the model does not offer", () => {
    const row: CapabilityRow = { ...TABLE[0]!, quantizations: ["q4"] };
    expect(bestFittingQuant(device(128), row, PREF)).toBe("q4");
  });
});
