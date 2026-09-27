/**
 * Loads Cedar's evaluator, `@cedar-policy/cedar-wasm`, once per process.
 *
 * The specifier is built at run time so the standalone tacho bundle does not
 * inline the package: the Node build reads `cedar_wasm_bg.wasm` from its own
 * directory, which only works from an installed copy. A host without the
 * package gets `null`, and the caller decides what an unavailable evaluator
 * means for the call in hand.
 */
import type * as CedarWasm from "@cedar-policy/cedar-wasm/nodejs";

/** The version every policy set is validated and evaluated with. */
export const CEDAR_WASM_VERSION = "4.13.0";

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

const SPECIFIER = ["@cedar-policy", "cedar-wasm/nodejs"].join("/");

let cached: Promise<CedarRuntime | null> | undefined;

async function load(): Promise<CedarRuntime | null> {
  try {
    const mod = (await import(/* @vite-ignore */ SPECIFIER)) as { default?: CedarRuntime } & CedarRuntime;
    const runtime = mod.default ?? mod;
    return typeof runtime.isAuthorized === "function" ? runtime : null;
  } catch {
    return null;
  }
}

/** The process's Cedar evaluator, or `null` when this host has none installed. */
export function loadCedarRuntime(): Promise<CedarRuntime | null> {
  cached ??= load();
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
