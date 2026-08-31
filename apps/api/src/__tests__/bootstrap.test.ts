/**
 * Unit tests for src/bootstrap.ts — idempotency guard
 *
 * Covers:
 * - Calling bootstrap() twice does not re-run init (booted guard)
 * - Concurrent double-call resolves safely without running init twice
 *
 * All infra is mocked so no DB/env required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock all infra deps before importing bootstrap ────────────────────────────

const mocks = vi.hoisted(() => ({
  loadEnv: vi.fn(),
  assertRlsConnectionSafe: vi.fn().mockResolvedValue(undefined),
  bootstrapIAMRuntime: vi.fn(),
  bootstrapBillingRuntime: vi.fn(),
  bootstrapEntitlementRuntime: vi.fn(),
  setSecurityEventEmitter: vi.fn(),
  recordSecurityEvent: vi.fn(),
  makeSecurityEventInserter: vi.fn().mockReturnValue(vi.fn()),
  // Side-effect register modules — these are pure side-effects; mocking them
  // prevents any accidental handler registration
  handlersRegister: vi.fn(),
  agentRegister: vi.fn(),
  // OXA-1753 email-transport boot probe deps.
  isEmailVerificationRequired: vi.fn().mockReturnValue(false),
  isEmailTransportConfigured: vi.fn().mockReturnValue(true),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@oxagen/config/env", () => ({
  loadEnv: mocks.loadEnv,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  assertRlsConnectionSafe: mocks.assertRlsConnectionSafe,

  };
});

vi.mock("@oxagen/iam", () => ({
  bootstrapIAMRuntime: mocks.bootstrapIAMRuntime,
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    bootstrapBillingRuntime: mocks.bootstrapBillingRuntime,
    verifyStripeSignature: vi.fn(),
    processStripeEvent: vi.fn(),
  };
});

vi.mock("@oxagen/plugins", () => ({
  bootstrapEntitlementRuntime: mocks.bootstrapEntitlementRuntime,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  setSecurityEventEmitter: mocks.setSecurityEventEmitter,
  setCapabilityEntitlementGate: vi.fn(),
  setDecisionRulesGate: vi.fn(),
  invoke: vi.fn(),
  clearHandlersForTests: vi.fn(),
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    recordSecurityEvent: mocks.recordSecurityEvent,
  };
});

vi.mock("@oxagen/database/security", () => ({
  makeSecurityEventInserter: mocks.makeSecurityEventInserter,
}));

// Mock the side-effect register imports
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));

vi.mock("@oxagen/auth", () => ({
  isEmailVerificationRequired: mocks.isEmailVerificationRequired,
}));

vi.mock("@oxagen/notifications", () => ({
  isEmailTransportConfigured: mocks.isEmailTransportConfigured,
}));

vi.mock("../middleware/logger", () => ({
  logger: {
    error: mocks.loggerError,
    warn: mocks.loggerWarn,
    info: mocks.loggerInfo,
  },
}));

// ── Import bootstrap and test helper ──────────────────────────────────────────

import { bootstrap, __resetBootForTesting } from "../bootstrap";

describe("bootstrap() idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the booted flag for each test so idempotency can be tested from scratch
    __resetBootForTesting();
  });

  it("calling bootstrap() once runs init (loadEnv called once)", async () => {
    await bootstrap();
    expect(mocks.loadEnv).toHaveBeenCalledTimes(1);
  });

  it("calling bootstrap() twice does not re-run init (booted guard)", async () => {
    // First call initializes; second call is guarded by booted flag
    await bootstrap();
    await bootstrap();
    // All init functions called exactly once despite two bootstrap() calls
    expect(mocks.loadEnv).toHaveBeenCalledTimes(1);
    expect(mocks.assertRlsConnectionSafe).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapIAMRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapBillingRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapEntitlementRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.setSecurityEventEmitter).toHaveBeenCalledTimes(1);
  });

  it("concurrent double-call resolves safely (no double-init)", async () => {
    // Fire two concurrent calls — only one should run init
    await Promise.all([bootstrap(), bootstrap()]);
    expect(mocks.loadEnv).toHaveBeenCalledTimes(1);
    expect(mocks.assertRlsConnectionSafe).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapIAMRuntime).toHaveBeenCalledTimes(1);
  });

  it("bootstrap() resolves (returns undefined)", async () => {
    const result = await bootstrap();
    expect(result).toBeUndefined();
  });
});

describe("bootstrap() retry on transient failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBootForTesting();
  });

  it("clears the memo on failure so a later call retries and recovers", async () => {
    // A transient cold-start failure (e.g. DB briefly unreachable during
    // assertRlsConnectionSafe) must NOT permanently wedge the instance.
    mocks.assertRlsConnectionSafe.mockRejectedValueOnce(new Error("db unreachable"));

    await expect(bootstrap()).rejects.toThrow("db unreachable");
    // Failed at step 2 (assertRls) → later wiring steps never ran.
    expect(mocks.assertRlsConnectionSafe).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapIAMRuntime).not.toHaveBeenCalled();

    // Recover: the memo was cleared, so the next call re-attempts and succeeds
    // (the one-time reject is consumed; the default resolves).
    await expect(bootstrap()).resolves.toBeUndefined();
    expect(mocks.assertRlsConnectionSafe).toHaveBeenCalledTimes(2);
    expect(mocks.bootstrapIAMRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.setSecurityEventEmitter).toHaveBeenCalledTimes(1);
  });

  it("a failed bootstrap rejects every concurrent caller, then a fresh call recovers", async () => {
    mocks.assertRlsConnectionSafe.mockRejectedValueOnce(new Error("boot blip"));

    const [a, b] = await Promise.allSettled([bootstrap(), bootstrap()]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    // Both shared the SAME in-flight promise — init attempted once.
    expect(mocks.assertRlsConnectionSafe).toHaveBeenCalledTimes(1);

    await expect(bootstrap()).resolves.toBeUndefined();
    expect(mocks.assertRlsConnectionSafe).toHaveBeenCalledTimes(2);
  });
});

describe("bootstrap() email-transport probe (OXA-1753)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBootForTesting();
    // Defaults — clearAllMocks resets the return values, so re-apply.
    mocks.assertRlsConnectionSafe.mockResolvedValue(undefined);
    mocks.makeSecurityEventInserter.mockReturnValue(vi.fn());
  });

  it("logs an error when deployed AND SMTP is unconfigured", async () => {
    mocks.isEmailVerificationRequired.mockReturnValue(true);
    mocks.isEmailTransportConfigured.mockReturnValue(false);

    await bootstrap();

    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    const [meta, msg] = mocks.loggerError.mock.calls[0]!;
    expect(meta).toMatchObject({ check: "email_transport", ticket: "OXA-1753" });
    expect(msg).toContain("email transport is unconfigured");
  });

  it("does NOT log an error when deployed AND SMTP is configured", async () => {
    mocks.isEmailVerificationRequired.mockReturnValue(true);
    mocks.isEmailTransportConfigured.mockReturnValue(true);

    await bootstrap();

    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it("does NOT log an error when running locally even if SMTP is missing", async () => {
    // Local dev has no real SMTP transport — the probe must not pollute logs.
    mocks.isEmailVerificationRequired.mockReturnValue(false);
    mocks.isEmailTransportConfigured.mockReturnValue(false);

    await bootstrap();

    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it("the probe is non-throwing — bootstrap still completes on misconfig", async () => {
    // OAuth sign-in doesn't need SMTP. The probe must observe-not-throw so a
    // missing transport never wedges a serverless cold-start.
    mocks.isEmailVerificationRequired.mockReturnValue(true);
    mocks.isEmailTransportConfigured.mockReturnValue(false);

    await expect(bootstrap()).resolves.toBeUndefined();
    expect(mocks.bootstrapIAMRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.setSecurityEventEmitter).toHaveBeenCalledTimes(1);
  });
});
