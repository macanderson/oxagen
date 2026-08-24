/**
 * trace.test.ts — pins the contract of the turn-trace barrel: it is a pure
 * type re-export of `@oxagen/agent-engine` and must stay framework-free with
 * ZERO runtime exports (the module doc reserves runtime presentation maps for
 * the renderer, not this barrel — a runtime binding appearing here is the
 * drift this module was rewritten to remove).
 *
 * The type side (that every documented name still resolves through the
 * barrel) is compile-checked by the `import type` below when the workspace
 * typechecker runs; vitest itself strips types without checking, so the
 * runtime assertion here is the no-runtime-exports half only.
 */
import { describe, expect, it } from "vitest";

// Compile-time pin: every name the barrel documents must keep resolving.
import type {
  StageKind,
  StageEvent,
  PromptEvaluation,
  ContextRetrieval,
  EnhancementTrace,
  PhaseStat,
  ToolEvent,
  JudgeVerdict,
  TurnTrace,
  ScopeReviewInfo,
  ScopeReviewDecision,
} from "./trace.js";

// Referenced so the imports above cannot be flagged unused; erased at runtime.
type ReexportedNames = [
  StageKind,
  StageEvent,
  PromptEvaluation,
  ContextRetrieval,
  EnhancementTrace,
  PhaseStat,
  ToolEvent,
  JudgeVerdict,
  TurnTrace,
  ScopeReviewInfo,
  ScopeReviewDecision,
];

describe("agent/trace barrel", () => {
  it("loads and exposes no runtime bindings — types only, framework-free", async () => {
    const barrel = await import("./trace.js");
    expect(Object.keys(barrel)).toEqual([]);
    // The tuple type above is the compile-time half of this contract.
    const witnessed: ReexportedNames extends unknown[] ? true : never = true;
    expect(witnessed).toBe(true);
  });
});
