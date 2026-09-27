import { afterEach, describe, expect, it, vi } from "vitest";

const SPECIFIER = "@cedar-policy/cedar-wasm/nodejs";

afterEach(() => {
  vi.doUnmock(SPECIFIER);
  vi.resetModules();
});

describe("loadCedarRuntime", () => {
  it("loads Cedar's evaluator once per process", async () => {
    const { loadCedarRuntime, requireCedarRuntime } = await import("./runtime");
    const first = await loadCedarRuntime();
    expect(first).not.toBeNull();
    expect(typeof first?.getCedarVersion()).toBe("string");
    expect(await loadCedarRuntime()).toBe(first);
    expect(await requireCedarRuntime()).toBe(first);
  });

  it("answers null when the package is not a Cedar evaluator", async () => {
    vi.doMock(SPECIFIER, () => ({ default: { name: "not cedar" } }));
    const { loadCedarRuntime, requireCedarRuntime } = await import("./runtime");
    expect(await loadCedarRuntime()).toBeNull();
    await expect(requireCedarRuntime()).rejects.toThrow(
      "Cedar's evaluator is not installed. Install @cedar-policy/cedar-wasm@4.13.0 beside this package.",
    );
  });

  it("answers null when the package cannot load", async () => {
    vi.doMock(SPECIFIER, () => {
      throw new Error("no such module");
    });
    const { loadCedarRuntime } = await import("./runtime");
    expect(await loadCedarRuntime()).toBeNull();
  });
});
