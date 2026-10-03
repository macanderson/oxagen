import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CedarRuntime } from "./runtime";

const SPECIFIER = "@cedar-policy/cedar-wasm/nodejs";

afterEach(() => {
  vi.doUnmock(SPECIFIER);
  vi.resetModules();
});

/** The wasm `tools/sea/compile.mjs` embeds: the Node build's file, read as bytes. */
function wasmBytes(): Uint8Array {
  const entry = createRequire(import.meta.url).resolve(SPECIFIER);
  return readFileSync(join(dirname(entry), "cedar_wasm_bg.wasm"));
}

function permitsEveryone(runtime: CedarRuntime): string | undefined {
  const answer = runtime.isAuthorized({
    principal: { type: "Agent", id: "a" },
    action: { type: "Action", id: "builtin__read" },
    resource: { type: "Target", id: "call" },
    context: {},
    policies: { staticPolicies: "permit (principal, action, resource);" },
    entities: [],
  });
  return answer.type === "success" ? answer.response.decision : undefined;
}

describe("loadCedarRuntime", () => {
  it("loads Cedar's evaluator once per process", async () => {
    const { loadCedarRuntime, requireCedarRuntime } = await import("./runtime");
    const first = await loadCedarRuntime();
    expect(first).not.toBeNull();
    expect(typeof first?.getCedarVersion()).toBe("string");
    expect(await loadCedarRuntime()).toBe(first);
    expect(await requireCedarRuntime()).toBe(first);
  });

  it("loads the version every policy set is validated with", async () => {
    // A lockfile that moves cedar-wasm fails here before any host runs it.
    const { CEDAR_WASM_VERSION, requireCedarRuntime } = await import("./runtime");
    expect((await requireCedarRuntime()).getCedarVersion()).toBe(CEDAR_WASM_VERSION);
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

  it("tries again once the retry wait has passed after a load that found no evaluator", async () => {
    // A failed load was kept for the life of the process, so the API signed
    // host bundles with no Cedar policies until it restarted (#5381).
    let attempts = 0;
    vi.doMock(SPECIFIER, () => {
      attempts += 1;
      if (attempts === 1) throw new Error("no such module");
      // At the top level: the proxy vitest puts around a mocked module
      // throws on any name the factory did not return.
      return { isAuthorized: () => undefined };
    });
    const { CEDAR_RETRY_AFTER_MS, loadCedarRuntime } = await import(
      "./runtime"
    );
    let clock = 1_000;
    const now = () => clock;
    expect(await loadCedarRuntime(now)).toBeNull();
    // Inside the wait the failure stands, so a hook does not load again.
    clock += CEDAR_RETRY_AFTER_MS - 1;
    expect(await loadCedarRuntime(now)).toBeNull();
    expect(attempts).toBe(1);
    clock += 1;
    const loaded = await loadCedarRuntime(now);
    expect(typeof loaded?.isAuthorized).toBe("function");
    expect(attempts).toBe(2);
    // A load that worked is kept.
    clock += CEDAR_RETRY_AFTER_MS * 10;
    expect(await loadCedarRuntime(now)).toBe(loaded);
    expect(attempts).toBe(2);
  });
});

describe("loadCedarRuntimeFrom", () => {
  it("instantiates a single executable's embedded wasm with the web build's glue", async () => {
    const { CEDAR_WASM_VERSION, loadCedarRuntimeFrom } = await import("./runtime");
    const nodeBuild = vi.fn(() => Promise.reject(new Error("the executable has no node_modules")));
    const runtime = await loadCedarRuntimeFrom({
      embeddedWasm: () => Promise.resolve(wasmBytes()),
      webGlue: () => import("@cedar-policy/cedar-wasm/web"),
      nodeBuild,
    });
    expect(runtime).not.toBeNull();
    expect(runtime?.getCedarVersion()).toBe(CEDAR_WASM_VERSION);
    expect(permitsEveryone(runtime as CedarRuntime)).toBe("allow");
    expect(nodeBuild).not.toHaveBeenCalled();
  });

  it("falls back to the Node build when the process carries no wasm", async () => {
    const { loadCedarRuntimeFrom } = await import("./runtime");
    const webGlue = vi.fn(() => Promise.reject(new Error("not used")));
    const runtime = await loadCedarRuntimeFrom({
      embeddedWasm: () => Promise.resolve(undefined),
      webGlue,
      nodeBuild: () => import("@cedar-policy/cedar-wasm/nodejs"),
    });
    expect(runtime).not.toBeNull();
    expect(permitsEveryone(runtime as CedarRuntime)).toBe("allow");
    expect(webGlue).not.toHaveBeenCalled();
  });

  it("answers null when the embedded wasm cannot be instantiated", async () => {
    const { loadCedarRuntimeFrom } = await import("./runtime");
    const nodeBuild = vi.fn(() => import("@cedar-policy/cedar-wasm/nodejs"));
    const runtime = await loadCedarRuntimeFrom({
      embeddedWasm: () => Promise.resolve(new Uint8Array([0, 1, 2, 3])),
      webGlue: () =>
        Promise.resolve({
          isAuthorized: () => undefined,
          initSync: () => {
            throw new Error("not a wasm module");
          },
        }),
      nodeBuild,
    });
    expect(runtime).toBeNull();
    expect(nodeBuild).not.toHaveBeenCalled();
  });

  it("answers null when the glue is not a Cedar evaluator", async () => {
    const { loadCedarRuntimeFrom } = await import("./runtime");
    const runtime = await loadCedarRuntimeFrom({
      embeddedWasm: () => Promise.resolve(new Uint8Array()),
      webGlue: () => Promise.resolve({ initSync: () => undefined, default: () => undefined }),
      nodeBuild: () => import("@cedar-policy/cedar-wasm/nodejs"),
    });
    expect(runtime).toBeNull();
  });

  it("reads the evaluator from a CommonJS module's default export", async () => {
    const { loadCedarRuntimeFrom } = await import("./runtime");
    const evaluator = { isAuthorized: () => undefined };
    const runtime = await loadCedarRuntimeFrom({
      embeddedWasm: () => Promise.resolve(undefined),
      webGlue: () => Promise.reject(new Error("not used")),
      nodeBuild: () => Promise.resolve({ default: evaluator }),
    });
    expect(runtime).toBe(evaluator);
  });
});
