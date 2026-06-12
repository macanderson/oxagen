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
  setSecurityEventEmitter: vi.fn(),
  recordSecurityEvent: vi.fn(),
  makeSecurityEventInserter: vi.fn().mockReturnValue(vi.fn()),
  // Side-effect register modules — these are pure side-effects; mocking them
  // prevents any accidental handler registration
  handlersRegister: vi.fn(),
  agentRegister: vi.fn(),
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

vi.mock("@oxagen/oxagen/kernel", () => ({
  setSecurityEventEmitter: mocks.setSecurityEventEmitter,
  setCapabilityEntitlementGate: vi.fn(),
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
