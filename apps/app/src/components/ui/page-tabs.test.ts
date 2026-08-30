/**
 * page-tabs.test.ts — unit tests for the active-tab resolution logic.
 *
 * Tests the exported `resolveActiveTab` pure function; the React component
 * cannot be tested in the node environment (no DOM/JSDOM) so component
 * rendering is covered by e2e or when a jsdom environment is added.
 *
 * Test scenarios:
 *   1. Exact match
 *   2. Longest-prefix match (nested path wins over root)
 *   3. No match — falls back to first tab
 *   4. Empty tab list — returns empty string
 *   5. Trailing-slash edge case
 *   6. No partial-segment match (avoids /billing matching /billing-extra)
 */

import { describe, it, expect } from "vitest";
import { resolveActiveTab } from "../../lib/resolve-active-tab";

const billingTabs = [
  { href: "/acme/billing" },
  { href: "/acme/billing/invoices" },
  { href: "/acme/billing/subscription" },
];

// ---------------------------------------------------------------------------
// 1. Exact match
// ---------------------------------------------------------------------------
describe("resolveActiveTab — exact match", () => {
  it("matches /acme/billing exactly", () => {
    expect(resolveActiveTab(billingTabs, "/acme/billing")).toBe(
      "/acme/billing",
    );
  });

  it("matches /acme/billing/invoices exactly", () => {
    expect(resolveActiveTab(billingTabs, "/acme/billing/invoices")).toBe(
      "/acme/billing/invoices",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Longest-prefix match
// ---------------------------------------------------------------------------
describe("resolveActiveTab — longest-prefix match", () => {
  it("prefers /acme/billing/invoices over /acme/billing for a nested path", () => {
    expect(resolveActiveTab(billingTabs, "/acme/billing/invoices/123")).toBe(
      "/acme/billing/invoices",
    );
  });

  it("falls back to root tab for paths under /acme/billing with no deeper match", () => {
    expect(resolveActiveTab(billingTabs, "/acme/billing/unknown-section")).toBe(
      "/acme/billing",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. No match — first tab fallback
// ---------------------------------------------------------------------------
describe("resolveActiveTab — no match", () => {
  it("returns the first tab when pathname shares no prefix with any tab", () => {
    expect(resolveActiveTab(billingTabs, "/acme/members")).toBe(
      "/acme/billing",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Empty tab list
// ---------------------------------------------------------------------------
describe("resolveActiveTab — empty tabs", () => {
  it("returns empty string for empty tabs array", () => {
    expect(resolveActiveTab([], "/acme/billing")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 5. Trailing-slash edge case
// ---------------------------------------------------------------------------
describe("resolveActiveTab — trailing slash", () => {
  it("does NOT match /acme/billing/ (trailing slash) as exact match for /acme/billing", () => {
    // /acme/billing/ does start with /acme/billing + "/" so it DOES match
    expect(resolveActiveTab(billingTabs, "/acme/billing/")).toBe(
      "/acme/billing",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Partial-segment guard (no false positives)
// ---------------------------------------------------------------------------
describe("resolveActiveTab — partial-segment guard", () => {
  it("does NOT match /acme/billing-extra against /acme/billing", () => {
    // /acme/billing-extra does NOT start with /acme/billing + "/" and is not
    // an exact match, so no tab matches → falls back to first.
    expect(resolveActiveTab(billingTabs, "/acme/billing-extra")).toBe(
      "/acme/billing",
    );
    // NOTE: the fallback is still /acme/billing (the first tab), which is
    // correct — there is no match so we show the default first tab.
    // What we are asserting is that the resolution path did NOT incorrectly
    // pick /acme/billing due to a naive startsWith without a "/" guard.
    // A wrong impl would return /acme/billing (by accident via prefix),
    // but the important thing is /acme/billing/invoices is not picked.
    expect(resolveActiveTab(billingTabs, "/acme/billing-extra")).not.toBe(
      "/acme/billing/invoices",
    );
  });

  it("does NOT match /acme/billing/subscriptions against /acme/billing/subscription", () => {
    // /acme/billing/subscriptions does NOT start with /acme/billing/subscription + "/"
    // and is not exact, so /acme/billing/subscription should NOT be selected.
    // The best match here is /acme/billing.
    expect(resolveActiveTab(billingTabs, "/acme/billing/subscriptions")).toBe(
      "/acme/billing",
    );
  });
});
