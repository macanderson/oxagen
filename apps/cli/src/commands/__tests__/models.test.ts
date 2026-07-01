import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Override only the side-effecting bits of the runtime layer; every pure helper
// (device detection, resolver, registry, cache readers) stays real so the
// command's formatting + branching is exercised end-to-end without a network,
// the optional native dep, or the real config file.
const h = vi.hoisted(() => ({
  state: {
    resolvedRow: null as { modelId: string } | null,
    resolvedQuant: null as string | null,
    rationale: "test rationale",
    available: false,
    pullResult: { path: "/cache/model.gguf", fromCache: false },
  },
  setCoordinator: vi.fn(),
  isOptionalDepInstalled: vi.fn(async () => true),
}));

vi.mock("../../runtime/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime/index.js")>();
  class FakeOnDeviceProvider {
    get resolvedRow() {
      return h.state.resolvedRow;
    }
    get resolvedQuant() {
      return h.state.resolvedQuant;
    }
    get rationale() {
      return h.state.rationale;
    }
    async isAvailable() {
      return h.state.available;
    }
    async pull() {
      return h.state.pullResult;
    }
  }
  return {
    ...actual,
    OnDeviceProvider: FakeOnDeviceProvider,
    setCoordinator: h.setCoordinator,
    isOptionalDepInstalled: h.isOptionalDepInstalled,
  };
});

import {
  handleModelsActive,
  handleModelsList,
  handleModelsPull,
  handleModelsStatus,
  handleModelsUse,
} from "../models.js";

let dir: string;
let stdout: string[];
let stderr: string[];

function captured(): string {
  return stdout.join("");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-models-cmd-"));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr.push(String(s));
    return true;
  });
  process.env["OXAGEN_MODELS_CACHE_DIR"] = dir;
  process.env["OXAGEN_COORDINATOR"] = "on-device";
  process.exitCode = 0;
  h.state.resolvedRow = { modelId: "small-7b" };
  h.state.resolvedQuant = "q4";
  h.state.available = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  delete process.env["OXAGEN_MODELS_CACHE_DIR"];
  delete process.env["OXAGEN_COORDINATOR"];
  process.exitCode = 0;
});

describe("models list", () => {
  it("emits structured JSON with device, on-device, and cloud sections", async () => {
    await handleModelsList({ json: true });
    const data = JSON.parse(captured());
    expect(data.device.ramGB).toBeGreaterThan(0);
    expect(data.coordinator).toBe("on-device");
    expect(Array.isArray(data.onDevice)).toBe(true);
    expect(data.onDevice.length).toBeGreaterThan(0);
    expect(data.cloud.map((c: { id: string }) => c.id)).toContain("haiku");
  });

  it("prints a human table", async () => {
    await handleModelsList();
    expect(captured()).toMatch(/On-device code models/);
    expect(captured()).toMatch(/Cloud models/);
  });
});

describe("models active", () => {
  it("describes an on-device coordinator", async () => {
    await handleModelsActive({ json: true });
    const data = JSON.parse(captured());
    expect(data.kind).toBe("on-device");
    expect(data.resolvedModel).toBe("small-7b");
    expect(typeof data.optionalDepInstalled).toBe("boolean");
    expect(data.ready).toBe(false);
  });

  it("describes a cloud coordinator", async () => {
    process.env["OXAGEN_COORDINATOR"] = "haiku";
    await handleModelsActive({ json: true });
    const data = JSON.parse(captured());
    expect(data.kind).toBe("cloud");
    expect(data.slug).toMatch(/anthropic\//);
  });

  it("prints a human summary for on-device", async () => {
    await handleModelsActive();
    expect(captured()).toMatch(/Coordinator: on-device/);
    expect(captured()).toMatch(/Resolved model:/);
  });
});

describe("models pull", () => {
  it("pulls the resolved model and reports the cache path", async () => {
    await handleModelsPull();
    expect(captured()).toMatch(/Downloaded and cached: \/cache\/model\.gguf/);
  });

  it("reports an already-cached model", async () => {
    h.state.pullResult = { path: "/cache/model.gguf", fromCache: true };
    await handleModelsPull({ json: true });
    const data = JSON.parse(captured());
    expect(data.fromCache).toBe(true);
    expect(data.modelId).toBe("small-7b");
  });

  it("explains and exits non-zero when nothing fits", async () => {
    h.state.resolvedRow = null;
    h.state.resolvedQuant = null;
    await handleModelsPull();
    expect(captured()).toMatch(/No on-device model fits/);
    expect(process.exitCode).toBe(1);
  });
});

describe("models status", () => {
  it("reports an empty cache with device fit", async () => {
    await handleModelsStatus({ json: true });
    const data = JSON.parse(captured());
    expect(data.cacheDir).toBe(dir);
    expect(data.entries).toEqual([]);
    expect(data.device.ramGB).toBeGreaterThan(0);
  });

  it("prints a human status", async () => {
    await handleModelsStatus();
    expect(captured()).toMatch(/No models cached/);
    expect(captured()).toMatch(/Device fit/);
  });
});

describe("models use", () => {
  it("sets a cloud coordinator", async () => {
    await handleModelsUse("haiku");
    expect(h.setCoordinator).toHaveBeenCalledWith("haiku");
    expect(captured()).toMatch(/Coordinator set to "haiku"/);
  });

  it("sets on-device and hints a pull when weights are missing", async () => {
    await handleModelsUse("on-device");
    expect(h.setCoordinator).toHaveBeenCalledWith("on-device");
    expect(captured()).toMatch(/models pull/);
  });

  it("rejects an unknown id and exits non-zero", async () => {
    await handleModelsUse("bogus");
    expect(captured()).toMatch(/Unknown model id/);
    expect(process.exitCode).toBe(1);
  });
});
