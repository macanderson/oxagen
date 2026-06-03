/**
 * seat-alert.test.ts — unit tests for the pure seatAlert() mapper.
 *
 * Covers all 3 states + boundary conditions:
 *   - over-provisioned (used > licenses) → error
 *   - at capacity (available === 0, free / single license) → warning
 *   - at capacity (available === 0, multi-license) → warning
 *   - seats available → success
 *   - boundary: used === licenses === 1 → warning (not error, exactly at limit)
 */

import { describe, it, expect } from "vitest";
import { seatAlert } from "./seat-alert";

const ORG = "acme";

describe("seatAlert", () => {
  // ── Error state ──────────────────────────────────────────────────────────────

  it("returns error when used > licenses", () => {
    const alert = seatAlert({ licenses: 2, used: 3, available: 0 }, ORG);
    expect(alert.variant).toBe("error");
    expect(alert.title).toMatch(/more members than licenses/i);
    expect(alert.cta?.href).toContain("/billing");
  });

  it("error alert body mentions member and license counts", () => {
    const alert = seatAlert({ licenses: 1, used: 2, available: 0 }, ORG);
    expect(alert.body).toContain("2");
    expect(alert.body).toContain("1");
  });

  it("error alert links to billing/subscription for the correct org", () => {
    const alert = seatAlert({ licenses: 2, used: 3, available: 0 }, "my-org");
    expect(alert.cta?.href).toBe("/my-org/billing/subscription");
  });

  // ── Warning state ─────────────────────────────────────────────────────────────

  it("returns warning when available === 0 and licenses === 1 (free plan)", () => {
    const alert = seatAlert({ licenses: 1, used: 1, available: 0 }, ORG);
    expect(alert.variant).toBe("warning");
    expect(alert.title).toMatch(/1 user license/i);
    expect(alert.cta?.href).toContain("/billing");
  });

  it("boundary: used === licenses === 1 → warning (exactly at limit, not error)", () => {
    const alert = seatAlert({ licenses: 1, used: 1, available: 0 }, ORG);
    expect(alert.variant).toBe("warning");
  });

  it("returns warning when available === 0 and licenses > 1 (multi-seat plan at capacity)", () => {
    const alert = seatAlert({ licenses: 5, used: 5, available: 0 }, ORG);
    expect(alert.variant).toBe("warning");
    expect(alert.title).toMatch(/5 licenses are in use/i);
    expect(alert.cta).toBeDefined();
  });

  it("warning alert includes CTA with href containing billing path", () => {
    const alert = seatAlert({ licenses: 3, used: 3, available: 0 }, ORG);
    expect(alert.cta?.href).toContain("/billing");
  });

  // ── Success state ─────────────────────────────────────────────────────────────

  it("returns success when available > 0", () => {
    const alert = seatAlert({ licenses: 5, used: 2, available: 3 }, ORG);
    expect(alert.variant).toBe("success");
    expect(alert.title).toContain("3");
    expect(alert.cta).toBeUndefined();
  });

  it("success body is singular when exactly 1 seat available", () => {
    const alert = seatAlert({ licenses: 2, used: 1, available: 1 }, ORG);
    expect(alert.variant).toBe("success");
    expect(alert.title).toMatch(/1 license available/i);
  });

  it("success body is plural when multiple seats available", () => {
    const alert = seatAlert({ licenses: 10, used: 4, available: 6 }, ORG);
    expect(alert.title).toMatch(/6 licenses available/i);
  });

  // ── Edge ──────────────────────────────────────────────────────────────────────

  it("uses correct orgSlug in CTA href", () => {
    const alert = seatAlert({ licenses: 1, used: 1, available: 0 }, "my-company");
    expect(alert.cta?.href).toContain("my-company");
  });
});
