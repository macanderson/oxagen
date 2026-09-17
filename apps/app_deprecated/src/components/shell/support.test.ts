/**
 * support.test.ts — unit tests for support.ts constants and types.
 *
 * These are static constants, so tests assert their shape and invariants.
 */
import { describe, it, expect } from "vitest";
import {
  DOCS_URL,
  SUPPORT_EMAIL,
  COMPANY_NAME,
  COMPANY_ADDRESS,
  SUPPORT_LINKS,
} from "./support";

describe("support constants", () => {
  it("DOCS_URL is a valid HTTPS URL", () => {
    expect(DOCS_URL).toMatch(/^https:\/\//);
  });

  it("SUPPORT_EMAIL contains an @ sign and a domain", () => {
    expect(SUPPORT_EMAIL).toMatch(/^[^@]+@[^@]+\.[^@]+$/);
  });

  it("COMPANY_NAME is non-empty", () => {
    expect(COMPANY_NAME.length).toBeGreaterThan(0);
  });

  it("COMPANY_ADDRESS is non-empty", () => {
    expect(COMPANY_ADDRESS.length).toBeGreaterThan(0);
  });
});

describe("SUPPORT_LINKS", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(SUPPORT_LINKS)).toBe(true);
    expect(SUPPORT_LINKS.length).toBeGreaterThan(0);
  });

  it("every link has label, description, and href", () => {
    for (const link of SUPPORT_LINKS) {
      expect(link.label.length).toBeGreaterThan(0);
      expect(link.description.length).toBeGreaterThan(0);
      expect(link.href.length).toBeGreaterThan(0);
    }
  });

  it("all external links use HTTPS", () => {
    const externalLinks = SUPPORT_LINKS.filter((l) => l.external);
    for (const link of externalLinks) {
      expect(link.href).toMatch(/^https:\/\//);
    }
  });

  it("Documentation link references DOCS_URL", () => {
    const docLink = SUPPORT_LINKS.find((l) => l.label === "Documentation");
    expect(docLink).toBeDefined();
    expect(docLink!.href).toContain(DOCS_URL);
  });

  it("links marked external: true have a flag", () => {
    const extLinks = SUPPORT_LINKS.filter((l) => l.external);
    expect(extLinks.length).toBeGreaterThan(0);
  });
});
