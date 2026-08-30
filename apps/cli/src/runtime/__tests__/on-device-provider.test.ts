import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutoDownloadDisabledError,
  NoFittingModelError,
  OnDeviceProvider,
  OptionalDepMissingError,
  type OnDeviceProviderDeps,
} from "../providers/on-device.js";
import type { FetchImpl } from "../provisioning/download.js";
import type { OnDeviceRuntime } from "../provisioning/optional-runtime.js";
import type { CapabilityRow, DeviceProfile, Quantization } from "../types.js";

const CONTENT = Buffer.from("on-device weight bytes for testing".repeat(3));

const ROW: CapabilityRow = {
  modelId: "small-7b",
  codeScore: 0.8,
  contextWindow: 131072,
  params: "7B",
  minRamGB: 6,
  quantizations: ["q4", "q8"],
  license: "Apache-2.0",
  sources: {
    q4: {
      url: "https://x.test/q4.gguf",
      sha256: "",
      sizeBytes: CONTENT.length,
    },
    q8: {
      url: "https://x.test/q8.gguf",
      sha256: "",
      sizeBytes: CONTENT.length,
    },
  },
};

const BIG: DeviceProfile = {
  ramGB: 128,
  vramGB: 0,
  gpu: null,
  cpuCores: 16,
  unifiedMemory: false,
};
const TINY: DeviceProfile = {
  ramGB: 2,
  vramGB: 0,
  gpu: null,
  cpuCores: 2,
  unifiedMemory: false,
};
const PREF: Quantization[] = ["q8", "q4"];

function fakeFetch(): FetchImpl {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    body: (async function* () {
      yield new Uint8Array(CONTENT);
    })(),
  }));
}

function fakeRuntime(): OnDeviceRuntime {
  return {
    name: "fake",
    load: vi.fn(async () => ({
      complete: vi.fn(async () => ({
        text: "def solution(): pass",
        usage: { inputTokens: 8, outputTokens: 4 },
      })),
      dispose: vi.fn(async () => {}),
    })),
  };
}

let dir: string;
function build(over: Partial<OnDeviceProviderDeps> = {}): OnDeviceProvider {
  return new OnDeviceProvider({
    device: BIG,
    table: [ROW],
    quantPref: PREF,
    modelId: "auto",
    cacheDir: dir,
    autoDownload: true,
    verifyChecksum: true,
    fetchImpl: fakeFetch(),
    loadRuntime: async () => fakeRuntime(),
    now: () => "2026-07-01T00:00:00Z",
    ...over,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-od-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolution", () => {
  it("resolves the best-quality quant that fits", () => {
    const p = build();
    expect(p.id()).toBe("small-7b");
    expect(p.kind()).toBe("on-device");
    expect(p.resolvedRow?.modelId).toBe("small-7b");
    expect(p.resolvedQuant).toBe("q8");
    expect(p.rationale).toMatch(/highest-scoring|pinned/);
  });

  it("resolves nothing on a device that is too small", () => {
    const p = build({ device: TINY });
    expect(p.resolvedRow).toBeNull();
    expect(p.id()).toBe("on-device");
    expect(p.capabilities().contextWindow).toBe(0);
  });
});

describe("isAvailable", () => {
  it("is false when the optional dep is missing", async () => {
    expect(await build({ loadRuntime: async () => null }).isAvailable()).toBe(
      false,
    );
  });

  it("is false before the weights are cached, true after a pull", async () => {
    const p = build();
    expect(await p.isAvailable()).toBe(false);
    await p.pull();
    expect(await p.isAvailable()).toBe(true);
  });
});

describe("ensureReady — never a silent fallback", () => {
  it("throws NoFittingModelError when nothing fits the device", async () => {
    await expect(build({ device: TINY }).ensureReady()).rejects.toBeInstanceOf(
      NoFittingModelError,
    );
  });

  it("throws OptionalDepMissingError when the runtime is absent", async () => {
    await expect(
      build({ loadRuntime: async () => null }).ensureReady(),
    ).rejects.toBeInstanceOf(OptionalDepMissingError);
  });

  it("throws AutoDownloadDisabledError when not cached and auto-download is off", async () => {
    await expect(
      build({ autoDownload: false }).ensureReady(),
    ).rejects.toBeInstanceOf(AutoDownloadDisabledError);
  });

  it("downloads the weights when auto-download is on", async () => {
    const fetchImpl = fakeFetch();
    const p = build({ fetchImpl });
    await p.ensureReady();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await p.isAvailable()).toBe(true);
  });
});

describe("pull", () => {
  it("downloads once and is a no-op against a valid cache", async () => {
    const fetchImpl = fakeFetch();
    const p = build({ fetchImpl });
    const first = await p.pull();
    expect(first.fromCache).toBe(false);
    const second = await p.pull();
    expect(second.fromCache).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("errors when the resolved model has no download source", async () => {
    const noSrc: CapabilityRow = { ...ROW, sources: {} };
    await expect(build({ table: [noSrc] }).pull()).rejects.toThrow(
      /No download source/,
    );
  });
});

describe("complete", () => {
  it("runs the on-device runtime and reports zero cloud cost", async () => {
    const p = build();
    const res = await p.complete({
      messages: [{ role: "user", content: "solve fizzbuzz" }],
    });
    expect(res.text).toBe("def solution(): pass");
    expect(res.kind).toBe("on-device");
    expect(res.model).toBe("small-7b");
    expect(res.costUsd).toBe(0);
    expect(res.usage.outputTokens).toBe(4);
    await p.dispose();
  });

  it("estimateCost is always zero for local inference", () => {
    const est = build().estimateCost({
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 50,
    });
    expect(est.usd).toBe(0);
    expect(est.tokens).toBeGreaterThan(0);
  });

  it("exposes code score + params in capabilities", () => {
    const caps = build().capabilities();
    expect(caps.codeScore).toBe(0.8);
    expect(caps.params).toBe("7B");
    expect(caps.offline).toBe(true);
  });
});
