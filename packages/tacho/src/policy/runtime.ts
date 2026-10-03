/**
 * Loads Cedar's evaluator, `@cedar-policy/cedar-wasm`, once per process.
 *
 * Two builds of tacho carry it in two ways:
 *
 * - The npm package (`tacho.mjs`, `tachod.mjs`, `tacho-hook.mjs`) depends on
 *   cedar-wasm and imports its Node build from `node_modules`. That build
 *   reads `cedar_wasm_bg.wasm` from its own directory, so the specifier is
 *   built at run time and esbuild leaves the package out of the bundle.
 * - The single executable (the desktop sidecar and the Homebrew binary) has
 *   no `node_modules`. `tools/sea/compile.mjs` embeds the wasm as the asset
 *   `cedar_wasm_bg.wasm`, and the web build's glue, which esbuild inlines,
 *   instantiates it from those bytes.
 *
 * A host with neither gets `null`, and the caller decides what an unavailable
 * evaluator means for the call in hand.
 */
import type * as CedarWasm from "@cedar-policy/cedar-wasm/nodejs";

/** The version every policy set is validated and evaluated with. */
export const CEDAR_WASM_VERSION = "4.13.0";

/** The single-executable asset that holds Cedar's wasm. */
export const CEDAR_WASM_ASSET = "cedar_wasm_bg.wasm";

/** The parts of cedar-wasm Oxagen calls. Tests can pass a stand-in. */
export type CedarRuntime = Pick<
  typeof CedarWasm,
  | "isAuthorized"
  | "isAuthorizedPartial"
  | "validate"
  | "policySetTextToParts"
  | "policyToJson"
  | "checkParseSchema"
  | "checkParsePolicySet"
  | "getCedarVersion"
>;

/** The web build's glue: the evaluator, plus `initSync`, which instantiates it from bytes. */
type CedarWebGlue = CedarRuntime & {
  initSync: (module: { module: ArrayBuffer | Uint8Array }) => unknown;
};

/** Where the evaluator can come from. Tests pass stand-ins. */
export interface CedarSources {
  /** The wasm a single executable carries, or `undefined` when this process is not one. */
  embeddedWasm: () => Promise<ArrayBuffer | Uint8Array | undefined>;
  /** The web build's glue. */
  webGlue: () => Promise<unknown>;
  /** The Node build, from `node_modules`. */
  nodeBuild: () => Promise<unknown>;
}

const SPECIFIER = ["@cedar-policy", "cedar-wasm/nodejs"].join("/");

interface SeaModule {
  isSea: () => boolean;
  getAsset: (key: string) => ArrayBuffer;
}

const DEFAULT_SOURCES: CedarSources = {
  embeddedWasm: () => {
    try {
      // `getBuiltinModule` loads `node:sea` synchronously, and esbuild leaves
      // it alone in both the ESM bundles and the CommonJS executable.
      const sea: SeaModule = process.getBuiltinModule("node:sea");
      return Promise.resolve(sea.isSea() ? sea.getAsset(CEDAR_WASM_ASSET) : undefined);
    } catch {
      // A Node without `getBuiltinModule`, or an executable built without the asset.
      return Promise.resolve(undefined);
    }
  },
  webGlue: () => import("@cedar-policy/cedar-wasm/web"),
  nodeBuild: () => import(/* @vite-ignore */ SPECIFIER),
};

function hasEvaluator(value: unknown): value is CedarRuntime {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Partial<CedarRuntime>).isAuthorized === "function"
  );
}

/**
 * The evaluator in a loaded module. The module itself carries it when it was
 * imported as ESM. A CommonJS module imported from ESM carries it on
 * `default`. The web glue's `default` is its async initializer, so the module
 * is checked first.
 */
function asRuntime(mod: unknown): CedarRuntime | null {
  if (hasEvaluator(mod)) return mod;
  if (mod !== null && typeof mod === "object") {
    const fallback = (mod as { default?: unknown }).default;
    if (hasEvaluator(fallback)) return fallback;
  }
  return null;
}

/**
 * The evaluator from the first source that has one: the executable's
 * embedded wasm, then the installed Node build.
 */
export async function loadCedarRuntimeFrom(sources: CedarSources): Promise<CedarRuntime | null> {
  const wasm = await sources.embeddedWasm();
  if (wasm !== undefined) {
    try {
      const glue = (await sources.webGlue()) as CedarWebGlue;
      glue.initSync({ module: wasm });
      return asRuntime(glue);
    } catch {
      return null;
    }
  }
  try {
    return asRuntime(await sources.nodeBuild());
  } catch {
    return null;
  }
}

/** How long a load that found no evaluator stands before the next try. */
export const CEDAR_RETRY_AFTER_MS = 60_000;

let cached: Promise<CedarRuntime | null> | undefined;
let failedAt: number | undefined;

/**
 * The process's Cedar evaluator, or `null` when this host has none.
 *
 * An evaluator that loaded is kept. A load that found none stands for
 * `CEDAR_RETRY_AFTER_MS`, then the next call tries again. The API and the
 * daemon run for days, and a failure kept for good left the API signing host
 * bundles with no Cedar policies until it restarted. The wait keeps a host
 * whose evaluator is broken from compiling the wasm again on every hook.
 */
export function loadCedarRuntime(
  now: () => number = Date.now,
): Promise<CedarRuntime | null> {
  if (failedAt !== undefined && now() - failedAt >= CEDAR_RETRY_AFTER_MS) {
    cached = undefined;
    failedAt = undefined;
  }
  cached ??= loadCedarRuntimeFrom(DEFAULT_SOURCES).then((runtime) => {
    if (runtime === null) failedAt = now();
    return runtime;
  });
  return cached;
}

/** The evaluator, or an error that says how to install it. */
export async function requireCedarRuntime(): Promise<CedarRuntime> {
  const runtime = await loadCedarRuntime();
  if (runtime === null) {
    throw new Error(
      `Cedar's evaluator is not installed. Install @cedar-policy/cedar-wasm@${CEDAR_WASM_VERSION} beside this package.`,
    );
  }
  return runtime;
}
