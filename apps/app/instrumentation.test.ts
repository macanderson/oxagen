// INV-23 (ARCHITECTURE.md §4): production boots the IAM, billing, entitlement,
// decision-rules and data-plane gates unconditionally. `register()` has one
// guard, the Node runtime; no environment variable skips a bootstrap.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const record = (name: string) =>
  vi.fn(() => {
    calls.push(name);
  });

const mocks = vi.hoisted(() => ({
  initTracer: vi.fn(),
  assertRlsConnectionSafe: vi.fn(),
  bootstrapDataPlaneResolver: vi.fn(),
  bootstrapIAMRuntime: vi.fn(),
  bootstrapBillingRuntime: vi.fn(),
  bootstrapEntitlementRuntime: vi.fn(),
  bootstrapDecisionRulesRuntime: vi.fn(),
  setSecurityEventEmitter: vi.fn(),
  recordSecurityEvent: vi.fn(),
  makeSecurityEventInserter: vi.fn(() => "inserter"),
}));

vi.mock("@oxagen/telemetry", () => ({
  initTracer: mocks.initTracer,
  recordSecurityEvent: mocks.recordSecurityEvent,
}));
vi.mock("@oxagen/iam", () => ({
  bootstrapIAMRuntime: mocks.bootstrapIAMRuntime,
}));
vi.mock("@oxagen/billing", () => ({
  bootstrapBillingRuntime: mocks.bootstrapBillingRuntime,
}));
vi.mock("@oxagen/plugins", () => ({
  bootstrapEntitlementRuntime: mocks.bootstrapEntitlementRuntime,
}));
vi.mock("@oxagen/rules", () => ({
  bootstrapDecisionRulesRuntime: mocks.bootstrapDecisionRulesRuntime,
}));
vi.mock("@oxagen/oxagen/kernel", () => ({
  setSecurityEventEmitter: mocks.setSecurityEventEmitter,
}));
vi.mock("@oxagen/database/security", () => ({
  makeSecurityEventInserter: mocks.makeSecurityEventInserter,
}));
vi.mock("@oxagen/database", () => ({
  assertRlsConnectionSafe: mocks.assertRlsConnectionSafe,
}));
vi.mock("@oxagen/database/data-plane", () => ({
  bootstrapDataPlaneResolver: mocks.bootstrapDataPlaneResolver,
}));

const { register } = await import("./instrumentation");

const BOOTSTRAPS = [
  "bootstrapDataPlaneResolver",
  "bootstrapIAMRuntime",
  "bootstrapBillingRuntime",
  "bootstrapEntitlementRuntime",
  "bootstrapDecisionRulesRuntime",
] as const;

beforeEach(() => {
  calls.length = 0;
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.assertRlsConnectionSafe.mockImplementation(
    record("assertRlsConnectionSafe"),
  );
  for (const name of BOOTSTRAPS) mocks[name].mockImplementation(record(name));
  mocks.makeSecurityEventInserter.mockReturnValue("inserter");
});

describe("register", () => {
  it("runs all five bootstraps in the Node runtime, after the RLS check, whatever the environment says", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "development");
    await register();
    expect(calls).toEqual(["assertRlsConnectionSafe", ...BOOTSTRAPS]);
    expect(mocks.initTracer).toHaveBeenCalledOnce();
    expect(mocks.setSecurityEventEmitter).toHaveBeenCalledOnce();
  });

  it("refuses to boot when the RLS check throws, and runs no bootstrap (negative)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    mocks.assertRlsConnectionSafe.mockRejectedValue(new Error("rls off"));
    await expect(register()).rejects.toThrow("rls off");
    expect(calls).toEqual([]);
  });

  it("does nothing outside the Node runtime (negative)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(calls).toEqual([]);
    expect(mocks.initTracer).not.toHaveBeenCalled();
  });

  it("maps a kernel security event to the Postgres emitter", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await register();
    const emitter = mocks.setSecurityEventEmitter.mock.calls[0]?.[0] as (
      event: Record<string, unknown>,
    ) => void;
    emitter({
      outcome: "deny",
      actorUserId: "u1",
      orgId: "o1",
      workspaceId: "w1",
      capability: "resolve_approval",
      requestId: "r1",
    });
    expect(mocks.recordSecurityEvent).toHaveBeenCalledWith(
      "inserter",
      expect.objectContaining({
        eventType: "capability.invoke_denied",
        outcome: "deny",
        capability: "resolve_approval",
      }),
    );
  });
});
