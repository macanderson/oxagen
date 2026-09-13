/**
 * oauth-prefill.test.ts — unit tests for the new-org form prefill derivation.
 *
 * Tests:
 *   1. emailDomain — extracts/normalizes the domain; rejects malformed input.
 *   2. isConsumerEmailDomain — consumer providers vs business domains; null.
 *   3. companyNameFromDomain — title-cases the registrable label; subdomains.
 *   4. buildOrgSignupPrefill — business domain seeds name+website; consumer
 *      domain does not; trims; provider passthrough; missing fields.
 */
import { describe, it, expect } from "vitest";
import {
  emailDomain,
  isConsumerEmailDomain,
  companyNameFromDomain,
  buildOrgSignupPrefill,
} from "./oauth-prefill";

describe("emailDomain", () => {
  it("extracts and lower-cases the domain", () => {
    expect(emailDomain("Jane@Acme.COM")).toBe("acme.com");
  });
  it("uses the last @ for quirky local parts", () => {
    expect(emailDomain("a@b@acme.io")).toBe("acme.io");
  });
  it("returns null for missing @, no dot, or empty/nullish", () => {
    expect(emailDomain("not-an-email")).toBeNull();
    expect(emailDomain("user@localhost")).toBeNull();
    expect(emailDomain("")).toBeNull();
    expect(emailDomain(null)).toBeNull();
    expect(emailDomain(undefined)).toBeNull();
  });
});

describe("isConsumerEmailDomain", () => {
  it("flags well-known consumer providers", () => {
    expect(isConsumerEmailDomain("gmail.com")).toBe(true);
    expect(isConsumerEmailDomain("ICLOUD.COM")).toBe(true);
    expect(isConsumerEmailDomain("proton.me")).toBe(true);
  });
  it("treats business domains as non-consumer", () => {
    expect(isConsumerEmailDomain("acme.com")).toBe(false);
    expect(isConsumerEmailDomain("oxagen.ai")).toBe(false);
  });
  it("treats null/empty as consumer (no business seeding)", () => {
    expect(isConsumerEmailDomain(null)).toBe(true);
    expect(isConsumerEmailDomain("")).toBe(true);
  });
});

describe("companyNameFromDomain", () => {
  it("title-cases the registrable label and splits separators", () => {
    expect(companyNameFromDomain("acme.com")).toBe("Acme");
    expect(companyNameFromDomain("acme-corp.io")).toBe("Acme Corp");
    expect(companyNameFromDomain("big_data.ai")).toBe("Big Data");
  });
  it("uses the second-to-last label, ignoring common subdomains", () => {
    expect(companyNameFromDomain("mail.acme.com")).toBe("Acme");
    expect(companyNameFromDomain("www.acme.com")).toBe("Acme");
  });
  it("returns '' for unusable input", () => {
    expect(companyNameFromDomain(null)).toBe("");
    expect(companyNameFromDomain("localhost")).toBe("");
  });
});

describe("buildOrgSignupPrefill", () => {
  it("seeds business name + website from a non-consumer domain", () => {
    const p = buildOrgSignupPrefill({
      name: "Jane Smith",
      email: "jane@acme-corp.io",
      image: "https://lh3.googleusercontent.com/a/x",
      provider: "google",
    });
    expect(p).toEqual({
      name: "Jane Smith",
      email: "jane@acme-corp.io",
      avatarUrl: "https://lh3.googleusercontent.com/a/x",
      provider: "google",
      suggestedBusinessName: "Acme Corp",
      suggestedWebsite: "https://acme-corp.io",
    });
  });

  it("does NOT seed business fields for a consumer domain", () => {
    const p = buildOrgSignupPrefill({
      name: "Jane Smith",
      email: "jane@gmail.com",
      image: "",
      provider: "github",
    });
    expect(p.suggestedBusinessName).toBe("");
    expect(p.suggestedWebsite).toBe("");
    expect(p.name).toBe("Jane Smith");
    expect(p.email).toBe("jane@gmail.com");
    expect(p.provider).toBe("github");
  });

  it("trims values and defaults missing fields", () => {
    const p = buildOrgSignupPrefill({
      name: "  Bob  ",
      email: "  bob@acme.com ",
    });
    expect(p.name).toBe("Bob");
    expect(p.email).toBe("bob@acme.com");
    expect(p.avatarUrl).toBe("");
    expect(p.provider).toBeNull();
    expect(p.suggestedBusinessName).toBe("Acme");
    expect(p.suggestedWebsite).toBe("https://acme.com");
  });

  it("handles a fully empty profile", () => {
    const p = buildOrgSignupPrefill({});
    expect(p).toEqual({
      name: "",
      email: "",
      avatarUrl: "",
      provider: null,
      suggestedBusinessName: "",
      suggestedWebsite: "",
    });
  });
});
