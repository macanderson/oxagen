/**
 * Unit tests for readRecordedCustomerId.
 *
 *  1. The settings column wins over a subscription row naming another id
 *     (the stale-after-cutover case, Codex P1 on #3392).
 *  2. An empty settings column falls back to the subscription row.
 *  3. Neither source → null.
 *  4. `system: true` routes through withSystemDb.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const world = vi.hoisted(() => ({
  settings: undefined as { stripeCustomerId: string | null } | undefined,
  subscription: undefined as { stripeCustomerId: string | null } | undefined,
}));

const tx = {
  query: {
    orgBillingSettings: { findFirst: vi.fn(async () => world.settings) },
    subscriptions: { findFirst: vi.fn(async () => world.subscription) },
  },
};

const seams = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: seams.withTenantDb,
    withSystemDb: seams.withSystemDb,
  };
});

import { readRecordedCustomerId } from "./recorded-customer";

describe("readRecordedCustomerId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    world.settings = undefined;
    world.subscription = undefined;
    seams.withTenantDb.mockImplementation(async (fn) => fn(tx));
    seams.withSystemDb.mockImplementation(async (fn) => fn(tx));
  });

  it("prefers the settings column over a subscription row's id", async () => {
    world.settings = { stripeCustomerId: "cus_live_new" };
    world.subscription = { stripeCustomerId: "cus_stale_old" };

    await expect(readRecordedCustomerId("org-abc")).resolves.toBe(
      "cus_live_new",
    );
    expect(tx.query.subscriptions.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to a subscription row when the settings column is empty", async () => {
    world.settings = { stripeCustomerId: null };
    world.subscription = { stripeCustomerId: "cus_sub_001" };

    await expect(readRecordedCustomerId("org-abc")).resolves.toBe(
      "cus_sub_001",
    );
  });

  it("returns null when no source names a customer", async () => {
    await expect(readRecordedCustomerId("org-abc")).resolves.toBeNull();
  });

  it("routes through withSystemDb when asked", async () => {
    world.settings = { stripeCustomerId: "cus_live_new" };

    await readRecordedCustomerId("org-abc", { system: true });

    expect(seams.withSystemDb).toHaveBeenCalledOnce();
    expect(seams.withTenantDb).not.toHaveBeenCalled();
  });
});
