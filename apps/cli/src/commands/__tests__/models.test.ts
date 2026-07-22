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
  const actual =
    await importOriginal<typeof import("../../runtime/index.js")>();
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
  handleModelsCapabilities,
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

describe("models capabilities", () => {
  // Reads the real, static @oxagen/ai posture registry directly — no mocks —
  // the same reason the underlying handler's own tests need none.

  it("prints the full vendor x axis table with no filter", async () => {
    await handleModelsCapabilities();
    const text = captured();
    expect(text).toMatch(/Provider capability posture matrix/);
    // All 8 gateway vendors must appear as rows.
    for (const vendor of [
      "anthropic",
      "openai",
      "google",
      "xai",
      "meta",
      "mistral",
      "deepseek",
      "bfl",
    ]) {
      expect(text).toMatch(new RegExp(`\\b${vendor}\\b`));
    }
    // Anthropic's opt-in cache posture is the motivating case — it must show.
    expect(text).toMatch(/anthropic\s+opt-in/);
  });

  it("emits the full matrix as JSON matching the capability's output shape", async () => {
    await handleModelsCapabilities({ json: true });
    const data = JSON.parse(captured());
    expect(data.unknownFilter).toBeNull();
    expect(Array.isArray(data.vendors)).toBe(true);
    expect(data.vendors).toHaveLength(8);
    const anthropic = data.vendors.find(
      (v: { vendor: string }) => v.vendor === "anthropic",
    );
    expect(anthropic.label).toBe("Anthropic");
    expect(anthropic.cache.kind).toBe("opt-in");
    expect(typeof anthropic.cache.witness).toBe("string");
    expect(anthropic.models.length).toBeGreaterThan(0);
  });

  it("filters to one vendor and shows mechanism + witness detail", async () => {
    await handleModelsCapabilities({ vendor: "anthropic" });
    const text = captured();
    expect(text).toMatch(/Anthropic \(anthropic\)/);
    expect(text).toMatch(/Cache: opt-in/);
    expect(text).toMatch(/cacheControl/);
    expect(text).toMatch(/Witness: "prepends the system prompt/);
    expect(text).toMatch(/Reasoning: controllable/);
    expect(text).toMatch(/Structured output: native/);
    expect(text).toMatch(/Attachments: supported/);
  });

  it("filters to one vendor as JSON", async () => {
    await handleModelsCapabilities({ vendor: "openai", json: true });
    const data = JSON.parse(captured());
    expect(data.unknownFilter).toBeNull();
    expect(data.vendors).toHaveLength(1);
    expect(data.vendors[0].vendor).toBe("openai");
    expect(data.vendors[0].cache.kind).toBe("implicit");
  });

  it("shows implicit-cache telemetry, a reasoning note, and emulated/text-only detail (deepseek)", async () => {
    await handleModelsCapabilities({ vendor: "deepseek" });
    const text = captured();
    expect(text).toMatch(/DeepSeek \(deepseek\)/);
    expect(text).toMatch(/Cache: implicit/);
    expect(text).toMatch(
      /cacheReadTokens|cached_tokens|prompt_cache_hit_tokens/,
    );
    expect(text).toMatch(/Reasoning: unsupported/);
    expect(text).toMatch(/Structured output: emulated/);
    expect(text).toMatch(/Attachments: text-only/);
  });

  it("shows n/a on every axis with its reason (bfl, image-only vendor)", async () => {
    await handleModelsCapabilities({ vendor: "bfl" });
    const text = captured();
    expect(text).toMatch(/Black Forest Labs \(bfl\)/);
    // displayKind() abbreviates "not-applicable" to "n/a" in human output.
    expect(text).toMatch(/Cache: n\/a/);
    expect(text).toMatch(/Reasoning: n\/a/);
    expect(text).toMatch(/Structured output: n\/a/);
    expect(text).toMatch(/Attachments: n\/a/);
    expect(text).not.toMatch(/Witness:/);
  });

  it("resolves a gateway model id to its vendor's posture", async () => {
    await handleModelsCapabilities({ model: "anthropic/claude-sonnet-5" });
    const text = captured();
    expect(text).toMatch(/Anthropic \(anthropic\)/);
    expect(text).toMatch(/Cache: opt-in/);
  });

  it("resolves a gateway model id as JSON", async () => {
    await handleModelsCapabilities({
      model: "anthropic/claude-sonnet-5",
      json: true,
    });
    const data = JSON.parse(captured());
    expect(data.vendors[0].vendor).toBe("anthropic");
    expect(data.unknownFilter).toBeNull();
  });

  it("reports an unknown vendor as explicitly unknown, never an empty table", async () => {
    await handleModelsCapabilities({ vendor: "some-byok-provider" });
    expect(captured()).toMatch(
      /No posture declared for "some-byok-provider" — unknown provider/,
    );
    expect(process.exitCode).toBe(1);
  });

  it("reports an unknown model id as explicitly unknown", async () => {
    await handleModelsCapabilities({
      model: "some-byok-provider/mystery-model",
    });
    expect(captured()).toMatch(
      /No posture declared for "some-byok-provider\/mystery-model" — unknown provider/,
    );
    expect(process.exitCode).toBe(1);
  });

  it("prefers the model filter over the vendor filter", async () => {
    await handleModelsCapabilities({
      vendor: "openai",
      model: "anthropic/claude-sonnet-5",
    });
    expect(captured()).toMatch(/Anthropic \(anthropic\)/);
  });

  it("returns an all-n/a row for the image-only vendor", async () => {
    await handleModelsCapabilities({ vendor: "bfl", json: true });
    const data = JSON.parse(captured());
    const row = data.vendors[0];
    expect(row.cache.kind).toBe("not-applicable");
    expect(row.reasoning.kind).toBe("not-applicable");
    expect(row.structuredOutput.kind).toBe("not-applicable");
    expect(row.attachments.kind).toBe("not-applicable");
  });
});
