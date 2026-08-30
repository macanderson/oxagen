import { describe, it, expect } from "vitest";
import {
  detectDevice,
  estimateModelRamGB,
  fitsDevice,
  memoryBudgetGB,
  paramsBillions,
  type DetectDeps,
} from "../device.js";
import type { DeviceProfile } from "../types.js";

const GB = 1024 ** 3;

function deps(
  over: Partial<{
    mem: number;
    cores: number;
    plat: NodeJS.Platform;
    arch: string;
  }>,
): DetectDeps {
  return {
    totalmemBytes: () => (over.mem ?? 16) * GB,
    cpuCount: () => over.cores ?? 8,
    platform: () => over.plat ?? "linux",
    arch: () => over.arch ?? "x64",
  };
}

describe("detectDevice", () => {
  it("treats Apple Silicon as unified memory with usable VRAM", () => {
    const d = detectDevice(
      deps({ mem: 32, plat: "darwin", arch: "arm64", cores: 12 }),
    );
    expect(d.unifiedMemory).toBe(true);
    expect(d.gpu).toBe("metal");
    expect(d.ramGB).toBe(32);
    expect(d.vramGB).toBeCloseTo(32 * 0.7, 1);
    expect(d.cpuCores).toBe(12);
  });

  it("reports CPU-only with no VRAM on non-Apple hardware", () => {
    const d = detectDevice(deps({ mem: 16, plat: "linux", arch: "x64" }));
    expect(d.unifiedMemory).toBe(false);
    expect(d.gpu).toBeNull();
    expect(d.vramGB).toBe(0);
  });

  it("never reports fewer than one CPU core", () => {
    const d = detectDevice(deps({ cores: 0 }));
    expect(d.cpuCores).toBe(1);
  });

  it("works with the real host probes (smoke)", () => {
    const d = detectDevice();
    expect(d.ramGB).toBeGreaterThan(0);
    expect(d.cpuCores).toBeGreaterThanOrEqual(1);
  });
});

describe("paramsBillions", () => {
  it("parses plain and MoE param labels (resident = total)", () => {
    expect(paramsBillions("32B")).toBe(32);
    expect(paramsBillions("7B")).toBe(7);
    expect(paramsBillions("30B-A3B")).toBe(30); // first number = resident weights
    expect(paramsBillions("nonsense")).toBe(0);
  });
});

describe("estimateModelRamGB", () => {
  it("grows with params and with quantization quality", () => {
    expect(estimateModelRamGB("7B", "q8")).toBeGreaterThan(
      estimateModelRamGB("7B", "q4"),
    );
    expect(estimateModelRamGB("32B", "q4")).toBeGreaterThan(
      estimateModelRamGB("7B", "q4"),
    );
  });
});

describe("memoryBudgetGB", () => {
  const base: DeviceProfile = {
    ramGB: 32,
    vramGB: 0,
    gpu: null,
    cpuCores: 8,
    unifiedMemory: false,
  };

  it("reserves RAM headroom on CPU-only hosts", () => {
    expect(memoryBudgetGB(base)).toBeCloseTo(32 * 0.65, 1);
  });

  it("uses dedicated VRAM when present", () => {
    expect(memoryBudgetGB({ ...base, vramGB: 24, gpu: "cuda" })).toBe(24);
  });

  it("uses the larger of RAM-headroom and VRAM on unified memory", () => {
    const d: DeviceProfile = {
      ramGB: 64,
      vramGB: 44.8,
      gpu: "metal",
      cpuCores: 12,
      unifiedMemory: true,
    };
    expect(memoryBudgetGB(d)).toBeCloseTo(44.8, 1);
  });
});

describe("fitsDevice", () => {
  it("fits a 7B q4 on a small laptop but not a 32B q8", () => {
    const laptop: DeviceProfile = {
      ramGB: 16,
      vramGB: 0,
      gpu: null,
      cpuCores: 8,
      unifiedMemory: false,
    };
    expect(fitsDevice(laptop, "7B", "q4")).toBe(true);
    expect(fitsDevice(laptop, "32B", "q8")).toBe(false);
  });
});
