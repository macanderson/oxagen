/**
 * Unit tests for bootstrap.ts — bootstrapBillingRuntime.
 *
 * Covers:
 *  - bootstrapBillingRuntime calls setBillingAdmissionGate on first call
 *  - bootstrapBillingRuntime is idempotent (second call is a no-op)
 *  - The gate function delegate calls assertCanStartTurn
 *
 * Each test gets a fresh module import so the `booted` module-level flag is
 * reset between tests. vi.resetModules() is called in beforeEach to ensure
 * the module cache is cleared and the mock factories run again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Top-level mocks are hoisted by vitest — they apply to all dynamic imports.
//
// Each factory carries `satisfies Pick<typeof import(...), the names it
// replaces>`, per ADR-037. This guards against a kernel rename of its
// admission-gate export silently leaving the factory returning a stale name,
// which would only surface later as a different test failing on an undefined
// call. With the annotation the rename fails in this file, at typecheck:
//
//   TS2344: Type '"setBudgetAdmissionGate"' does not satisfy the constraint
//   'keyof typeof import(".../kernel")'.
//
// `Pick` rather than the whole module type on purpose. `satisfies typeof
// import(...)` demands the factory reproduce every export — twelve of them for
// ./metering — and a pino Logger down to `fatal`/`trace`/`silent`. `Pick` asks
// the only question worth asking: do the names this file replaces still exist?
// It is a type, so it costs nothing at runtime; spreading `importOriginal()`
// instead would import the real kernel, database client and logger, and the
// suite times out at 5s rather than running.
const setBillingAdmissionGateMock = vi.fn();
const setBudgetAdmissionGateMock = vi.fn();
vi.mock(
  "@oxagen/oxagen/kernel",
  () =>
    ({
      setBillingAdmissionGate: setBillingAdmissionGateMock,
      setBudgetAdmissionGate: setBudgetAdmissionGateMock,
    }) satisfies Pick<
      typeof import("@oxagen/oxagen/kernel"),
      "setBillingAdmissionGate" | "setBudgetAdmissionGate"
    >,
);

const assertCanStartTurnMock = vi.fn().mockResolvedValue(undefined);
vi.mock(
  "./metering",
  () =>
    ({ assertCanStartTurn: assertCanStartTurnMock }) satisfies Pick<
      typeof import("./metering"),
      "assertCanStartTurn"
    >,
);

const assertWithinSpendBudgetMock = vi.fn().mockResolvedValue(undefined);
vi.mock(
  "./spend-budget-gate",
  () =>
    ({ assertWithinSpendBudget: assertWithinSpendBudgetMock }) satisfies Pick<
      typeof import("./spend-budget-gate"),
      "assertWithinSpendBudget"
    >,
);

// `logger` carries no annotation. `Pick<typeof import("./logger"), "logger">`
// would demand the double be a full pino Logger — `level`, `fatal`, `trace`,
// `silent`, `msgPrefix` — to replace four methods a bootstrap test never reads.
// The check is skipped deliberately here rather than satisfied with a cast that
// would look like a check and be none.
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

describe("bootstrapBillingRuntime", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls setBillingAdmissionGate once", async () => {
    const { bootstrapBillingRuntime } = await import("./bootstrap");
    bootstrapBillingRuntime();
    expect(setBillingAdmissionGateMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — second call does not call setBillingAdmissionGate again", async () => {
    const { bootstrapBillingRuntime } = await import("./bootstrap");
    bootstrapBillingRuntime();
    bootstrapBillingRuntime();
    // Still only 1 call total (module-level booted flag prevents re-registration).
    expect(setBillingAdmissionGateMock).toHaveBeenCalledTimes(1);
  });

  it("the registered gate delegates to assertCanStartTurn", async () => {
    const { bootstrapBillingRuntime } = await import("./bootstrap");
    bootstrapBillingRuntime();
    // The gate function was registered in the call above — extract it.
    const gateFn = setBillingAdmissionGateMock.mock.calls[0]?.[0] as
      | ((orgId: string) => Promise<void>)
      | undefined;
    expect(gateFn).toBeDefined();
    await gateFn!("org-test");
    expect(assertCanStartTurnMock).toHaveBeenCalledWith("org-test");
  });
});
