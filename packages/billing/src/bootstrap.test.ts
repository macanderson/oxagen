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
const setUsageRecorderMock = vi.fn();
vi.mock(
  "@oxagen/oxagen/kernel",
  () =>
    ({
      setBillingAdmissionGate: setBillingAdmissionGateMock,
      setBudgetAdmissionGate: setBudgetAdmissionGateMock,
      setUsageRecorder: setUsageRecorderMock,
    }) satisfies Pick<
      typeof import("@oxagen/oxagen/kernel"),
      | "setBillingAdmissionGate"
      | "setBudgetAdmissionGate"
      | "setUsageRecorder"
    >,
);

// ADR-052 accrual. Both are mocked because the real ones open a tenant scope
// and a system-db connection, which a bootstrap test has no business needing:
// the question here is only whether bootstrap wires the recorder to them.
const recordGovernedActionMock = vi.fn().mockResolvedValue({
  periodActions: 1,
  billableActions: 0,
  band: { id: "first-1m", minAnnualActions: 0, maxAnnualActions: 1_000_000, usdPer1000: 20 },
  creditsCharged: 0n,
  shortfallCredits: 0n,
  mode: "charge" as const,
});
vi.mock(
  "./action-metering",
  () =>
    ({ recordGovernedAction: recordGovernedActionMock }) satisfies Pick<
      typeof import("./action-metering"),
      "recordGovernedAction"
    >,
);

const resolveOrgActionEntitlementMock = vi
  .fn()
  .mockResolvedValue({ tier: "scale" as const, includedActionsAnnual: 1_500_000 });
vi.mock(
  "./plan-allowance",
  () =>
    ({
      resolveOrgActionEntitlement: resolveOrgActionEntitlementMock,
    }) satisfies Pick<
      typeof import("./plan-allowance"),
      "resolveOrgActionEntitlement"
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

  // ── ADR-052: accrual is wired, and wired separately from admission ────────
  it("registers the governed-action usage recorder", async () => {
    const { bootstrapBillingRuntime } = await import("./bootstrap");
    bootstrapBillingRuntime();
    expect(setUsageRecorderMock).toHaveBeenCalledTimes(1);
  });

  it("the registered recorder resolves the org's entitlement and records the action against it", async () => {
    const { bootstrapBillingRuntime } = await import("./bootstrap");
    bootstrapBillingRuntime();
    const recorder = setUsageRecorderMock.mock.calls[0]?.[0] as
      | ((record: Record<string, unknown>) => Promise<void>)
      | undefined;
    expect(recorder).toBeDefined();

    const occurredAt = new Date("2026-03-04T05:06:07.000Z");
    await recorder!({
      orgId: "org-test",
      workspaceId: "ws-test",
      capability: "query_ontology",
      surface: "api",
      principalId: null,
      principalKind: null,
      userId: null,
      runId: "run-test",
      requestId: "req-test",
      actions: 3,
      durationMs: 12,
      occurredAt,
    });

    expect(resolveOrgActionEntitlementMock).toHaveBeenCalledWith("org-test");
    // The tier and allowance come from the entitlement read, not from the
    // record — a caller cannot talk itself onto a cheaper band by claiming one.
    expect(recordGovernedActionMock).toHaveBeenCalledWith({
      orgId: "org-test",
      actions: 3,
      capability: "query_ontology",
      tier: "scale",
      planIncludedActions: 1_500_000,
      runId: "run-test",
      now: occurredAt,
    });
  });
});
