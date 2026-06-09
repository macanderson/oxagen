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

// ── Reset the booted state between tests ──────────────────────────────────────
// bootstrap.ts uses a module-level `let booted = false`. To reset it between
// tests we use vi.resetModules() and re-import the module.

describe("bootstrap() idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module registry so the `booted` variable starts fresh
    vi.resetModules();
  });

  it("calling bootstrap() once runs init (loadEnv called once)", async () => {
    const { bootstrap } = await import("../bootstrap");
    await bootstrap();
    expect(mocks.loadEnv).toHaveBeenCalledTimes(1);
  });

  it("calling bootstrap() twice does not re-run init (booted guard)", async () => {
    const { bootstrap } = await import("../bootstrap");
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
    const { bootstrap } = await import("../bootstrap");
    // Fire two concurrent calls — only one should run init
    await Promise.all([bootstrap(), bootstrap()]);
    expect(mocks.loadEnv).toHaveBeenCalledTimes(1);
    expect(mocks.assertRlsConnectionSafe).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapIAMRuntime).toHaveBeenCalledTimes(1);
  });

  it("bootstrap() resolves (returns undefined)", async () => {
    const { bootstrap } = await import("../bootstrap");
    const result = await bootstrap();
    expect(result).toBeUndefined();
  });
});
