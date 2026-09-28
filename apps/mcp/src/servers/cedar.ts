// cedar.ts: Cedar's evaluator from a loaded module (lane M15).
//
// The Node build exports the evaluator's functions at the top level, and a
// bundler can wrap them in a default export. Either shape serves. Anything
// else is no evaluator, and the gateway serves no tool.
import type { CedarRuntime } from "@oxagen/policy";

function hasEvaluator(mod: unknown): mod is CedarRuntime {
  return typeof mod === "object" && mod !== null && typeof (mod as { isAuthorized?: unknown }).isAuthorized === "function";
}

/** The module's evaluator, or its default export's, or null. */
export function asCedarRuntime(mod: unknown): CedarRuntime | null {
  if (hasEvaluator(mod)) return mod;
  if (typeof mod === "object" && mod !== null) {
    const fallback = (mod as { default?: unknown }).default;
    if (hasEvaluator(fallback)) return fallback;
  }
  return null;
}
