import { describe, it, expect } from "vitest";
import { SUB_PROCESSORS, TRUST_SIGNALS } from "./trust-content";

describe("SUB_PROCESSORS", () => {
  it("contains at least 4 entries", () => {
    expect(SUB_PROCESSORS.length).toBeGreaterThanOrEqual(4);
  });

  it("every sub-processor has required fields", () => {
    for (const sp of SUB_PROCESSORS) {
      expect(sp.name).toBeTruthy();
      expect(sp.category).toBeTruthy();
      expect(sp.purpose).toBeTruthy();
      expect(sp.dataRegion).toBeTruthy();
      expect(Array.isArray(sp.certifications)).toBe(true);
      expect(sp.certifications.length).toBeGreaterThan(0);
    }
  });

  it("includes Stripe, Inngest, Vercel, and Google Cloud", () => {
    const names = SUB_PROCESSORS.map((sp) => sp.name);
    expect(names).toContain("Stripe");
    expect(names).toContain("Inngest");
    expect(names).toContain("Vercel");
    expect(names).toContain("Google Cloud");
  });

  it("all privacyUrl values (when present) start with https://", () => {
    for (const sp of SUB_PROCESSORS) {
      if (sp.privacyUrl) {
        expect(sp.privacyUrl).toMatch(/^https:\/\//);
      }
    }
  });

  it("Stripe has PCI DSS certification", () => {
    const stripe = SUB_PROCESSORS.find((sp) => sp.name === "Stripe")!;
    expect(stripe.certifications.some((c) => c.includes("PCI"))).toBe(true);
  });
});

describe("TRUST_SIGNALS", () => {
  it("contains at least 5 signals", () => {
    expect(TRUST_SIGNALS.length).toBeGreaterThanOrEqual(5);
  });

  it("every signal has id, title, and description", () => {
    for (const sig of TRUST_SIGNALS) {
      expect(sig.id).toBeTruthy();
      expect(sig.title).toBeTruthy();
      expect(sig.description).toBeTruthy();
    }
  });

  it("ids are unique", () => {
    const ids = TRUST_SIGNALS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes encryption-at-rest and TLS signals", () => {
    const ids = TRUST_SIGNALS.map((s) => s.id);
    expect(ids).toContain("encryption_at_rest");
    expect(ids).toContain("tls_in_transit");
  });
});
