import { describe, expect, it } from "vitest";
import { organizationCreate } from "./organization.create";

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
    const parsed = organizationCreate.input.parse({ name: "Acme", slug: "acme" });
    expect(parsed.planSlug).toBe("free");
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
      createdAt: new Date().toISOString(),
    });
    expect(parsed.publicId).toBe("org_abc");
  });
});
