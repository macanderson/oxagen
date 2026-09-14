import { describe, expect, it } from "vitest";
import { organizationCreate } from "./org.create";

describe("organization.create capability", () => {
  it("parses a valid input", () => {
    const parsed = organizationCreate.input.parse({
      name: "Acme",
      slug: "acme",
      planSlug: "free",
    });
    expect(parsed.slug).toBe("acme");
  });

  it("applies the default plan slug", () => {
    const parsed = organizationCreate.input.parse({
      name: "Acme",
      slug: "acme",
    });
    expect(parsed.planSlug).toBe("free");
  });

  it("rejects client-selected privileged plan slugs", () => {
    expect(() =>
      organizationCreate.input.parse({
        name: "Forged Enterprise",
        slug: "forged-enterprise",
        planSlug: "enterprise",
      }),
    ).toThrow();
  });

  it("rejects an uppercase slug", () => {
    expect(() =>
      organizationCreate.input.parse({ name: "Acme", slug: "Acme" }),
    ).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() =>
      organizationCreate.input.parse({ name: "", slug: "acme" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = organizationCreate.output.parse({
      publicId: "org_abc",
      name: "Acme",
      slug: "acme",
      type: "business",
      createdAt: new Date().toISOString(),
    });
    expect(parsed.publicId).toBe("org_abc");
    expect(parsed.type).toBe("business");
  });

  it("defaults type to business", () => {
    const parsed = organizationCreate.input.parse({
      name: "Acme",
      slug: "acme",
    });
    expect(parsed.type).toBe("business");
  });

  it("rejects business-only fields on a personal account", () => {
    expect(() =>
      organizationCreate.input.parse({
        name: "Me",
        slug: "me",
        type: "personal",
        industry: "software-it",
      }),
    ).toThrow();
  });

  it("accepts a business account with industry and employee size", () => {
    const parsed = organizationCreate.input.parse({
      name: "Acme",
      slug: "acme",
      type: "business",
      website: "https://acme.example",
      industry: "software-it",
      employeeSize: "11-50",
    });
    expect(parsed.industry).toBe("software-it");
    expect(parsed.employeeSize).toBe("11-50");
  });
});
