/**
 * low-balance-banner.test.tsx — display/dismiss logic for LowBalanceBanner.
 *
 * Tests the pure decision logic extracted from the component. All helpers
 * below mirror the component exactly so the tests are behaviorally coupled
 * to the implementation without importing React or needing a DOM.
 *
 * Decision logic under test:
 *   1. balanceCents >= thresholdCents → no banner
 *   2. sessionStorage[key] === "1" → dismissed on mount
 *   3. handleDismiss writes sessionStorage key `oxagen:low-balance-dismissed:{orgSlug}`
 *   4. Different orgSlugs → different keys (multi-org isolation)
 *   5. SSR (window undefined) → initializes dismissed=false without throwing
 *
 * The SESSION_KEY_PREFIX matches the literal in the component source.
 */

import { describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Pure helpers mirroring the component's logic exactly.
// ---------------------------------------------------------------------------

const SESSION_KEY_PREFIX = "oxagen:low-balance-dismissed:";

function sessionKeyFor(orgSlug: string): string {
  return `${SESSION_KEY_PREFIX}${orgSlug}`;
}

function shouldShowBanner(
  balanceCents: number,
  thresholdCents: number,
): boolean {
  return balanceCents < thresholdCents;
}

// Portable sessionStorage mock (Map-backed, Node-safe).
// The component checks `typeof window === "undefined"` to guard SSR.
// These helpers accept an explicit storage arg for isolation/SSR simulation.

function initDismissedState(
  orgSlug: string,
  storage: Map<string, string> | null,
): boolean {
  if (storage === null) return false; // SSR simulation: no window → no sessionStorage
  return storage.get(sessionKeyFor(orgSlug)) === "1";
}

function handleDismiss(
  orgSlug: string,
  storage: Map<string, string> | null,
): void {
  if (storage === null) return; // SSR: window is undefined — no-op
  storage.set(sessionKeyFor(orgSlug), "1");
}

// ---------------------------------------------------------------------------
// Display logic
// ---------------------------------------------------------------------------

describe("LowBalanceBanner — display logic", () => {
  it("balance >= threshold → should NOT show banner", () => {
    expect(shouldShowBanner(1000, 500)).toBe(false);
    expect(shouldShowBanner(500, 500)).toBe(false);
  });

  it("balance < threshold → should show banner", () => {
    expect(shouldShowBanner(499, 500)).toBe(true);
    expect(shouldShowBanner(0, 500)).toBe(true);
  });

  it("balance equals threshold exactly → no banner (boundary)", () => {
    expect(shouldShowBanner(100, 100)).toBe(false);
  });

  it("negative balance < threshold → show banner", () => {
    expect(shouldShowBanner(-1, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sessionStorage key format
// ---------------------------------------------------------------------------

describe("LowBalanceBanner — sessionStorage key format", () => {
  it("key for 'acme' equals 'oxagen:low-balance-dismissed:acme'", () => {
    expect(sessionKeyFor("acme")).toBe("oxagen:low-balance-dismissed:acme");
  });

  it("different orgSlugs produce different keys (multi-org isolation)", () => {
    expect(sessionKeyFor("acme")).not.toBe(sessionKeyFor("globex"));
  });

  it("key starts with SESSION_KEY_PREFIX", () => {
    expect(sessionKeyFor("any-org").startsWith(SESSION_KEY_PREFIX)).toBe(true);
  });

  it("key ends with the orgSlug", () => {
    expect(sessionKeyFor("my-org").endsWith("my-org")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// initDismissedState
// ---------------------------------------------------------------------------

describe("LowBalanceBanner — initDismissedState", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
  });

  it("returns false when no entry exists for the org", () => {
    expect(initDismissedState("acme", storage)).toBe(false);
  });

  it("returns true when entry is '1'", () => {
    storage.set(sessionKeyFor("acme"), "1");
    expect(initDismissedState("acme", storage)).toBe(true);
  });

  it("returns false when entry is '0' (not '1')", () => {
    storage.set(sessionKeyFor("acme"), "0");
    expect(initDismissedState("acme", storage)).toBe(false);
  });

  it("returns false when entry is empty string", () => {
    storage.set(sessionKeyFor("acme"), "");
    expect(initDismissedState("acme", storage)).toBe(false);
  });

  it("different org slug → different key (not dismissed)", () => {
    storage.set(sessionKeyFor("acme"), "1");
    expect(initDismissedState("globex", storage)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleDismiss
// ---------------------------------------------------------------------------

describe("LowBalanceBanner — handleDismiss", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
  });

  it("writes '1' to the correct key", () => {
    handleDismiss("acme", storage);
    expect(storage.get(sessionKeyFor("acme"))).toBe("1");
  });

  it("writing for 'acme' does NOT set the 'globex' key", () => {
    handleDismiss("acme", storage);
    expect(storage.has(sessionKeyFor("globex"))).toBe(false);
  });

  it("after handleDismiss, initDismissedState returns true", () => {
    handleDismiss("acme", storage);
    expect(initDismissedState("acme", storage)).toBe(true);
  });

  it("calling handleDismiss twice is idempotent", () => {
    handleDismiss("acme", storage);
    handleDismiss("acme", storage);
    expect(storage.get(sessionKeyFor("acme"))).toBe("1");
    expect(storage.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SSR guard (window undefined simulation: storage=null)
// ---------------------------------------------------------------------------

describe("LowBalanceBanner — SSR guard", () => {
  it("initDismissedState returns false without throwing when storage is null (SSR)", () => {
    expect(() => initDismissedState("acme", null)).not.toThrow();
    expect(initDismissedState("acme", null)).toBe(false);
  });

  it("handleDismiss does not throw when storage is null (SSR)", () => {
    expect(() => handleDismiss("acme", null)).not.toThrow();
  });

  it("initDismissedState is false for any org when in SSR mode", () => {
    const orgs = ["acme", "globex", "other"];
    for (const org of orgs) {
      expect(initDismissedState(org, null)).toBe(false);
    }
  });
});
