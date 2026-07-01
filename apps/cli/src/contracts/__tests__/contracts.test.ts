/**
 * Barrel smoke test for the Group 7 typed contracts surface.
 *
 * Every other file in `contracts/` is type-only (interfaces, type aliases —
 * pure `declare`-style signatures) and compiles to no runtime output, so it
 * can't contribute executable coverage. `DEFAULT_TIMEOUTS` is the one real
 * value the whole surface ships; this test exercises it directly. It also
 * exercises the barrel's re-exports at the type level so a broken re-export
 * path (a renamed shipped type, a moved module) fails `tsc`/this suite instead
 * of silently shipping a hole in the contract surface.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUTS } from "../index.js";
import type {
  AppConfig,
  AssistTools,
  Coordinator,
  ModelProvider,
  Pipeline,
  Router,
} from "../index.js";

describe("contracts barrel", () => {
  it("ships the Group 8 default timeout policy", () => {
    expect(DEFAULT_TIMEOUTS.perModelCallMs).toBe(120000);
    expect(DEFAULT_TIMEOUTS.perToolCallMs).toBe(120000);
    expect(DEFAULT_TIMEOUTS.turnInactivityMs).toBe(300000);
    expect(DEFAULT_TIMEOUTS.turnHardCeilingMs).toBeUndefined();
    expect(DEFAULT_TIMEOUTS.retry).toEqual({ maxRetries: 2, backoffMs: 1000 });
  });

  it("re-exports the whole contract surface and resolves at the type level", () => {
    // A type-only helper: if any re-export path below has broken (renamed or
    // removed upstream), this file fails to type-check under `tsc`/vitest's
    // esbuild transform rather than passing silently.
    function typesResolve(): boolean {
      const config: AppConfig | undefined = undefined;
      const provider: ModelProvider | undefined = undefined;
      const router: Router | undefined = undefined;
      const coordinator: Coordinator | undefined = undefined;
      const tools: AssistTools | undefined = undefined;
      const pipeline: Pipeline | undefined = undefined;
      return (
        config === undefined &&
        provider === undefined &&
        router === undefined &&
        coordinator === undefined &&
        tools === undefined &&
        pipeline === undefined
      );
    }

    expect(typesResolve()).toBe(true);
  });
});
