import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIRST_WORKSPACE,
  RESERVED_ORG_SLUGS,
  RESERVED_WORKSPACE_SLUGS,
  organizationCreate,
} from "./org.create";

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
      workspace: { publicId: "ws_abc", slug: "core" },
    });
    expect(parsed.publicId).toBe("org_abc");
    expect(parsed.type).toBe("business");
    expect(parsed.workspace.slug).toBe("core");
  });

  it("rejects an output with no first workspace", () => {
    expect(() =>
      organizationCreate.output.parse({
        publicId: "org_abc",
        name: "Acme",
        slug: "acme",
        type: "business",
        createdAt: new Date().toISOString(),
      }),
    ).toThrow();
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

  describe("reserved slugs", () => {
    it("refuses every reserved org slug at the slug path", () => {
      for (const slug of RESERVED_ORG_SLUGS) {
        const result = organizationCreate.input.safeParse({
          name: "Shadow",
          slug,
        });
        expect(result.success, slug).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0]?.path).toEqual(["slug"]);
        }
      }
    });

    it("covers every top-level route segment the app owns", () => {
      for (const segment of [
        "login",
        "signup",
        "verify",
        "two-factor",
        "forgot-password",
        "reset-password",
        "invite",
        "new-organization",
        "api",
        "cli",
        "github",
        "_next",
      ]) {
        expect(RESERVED_ORG_SLUGS.has(segment), segment).toBe(true);
      }
    });

    it("accepts a slug that merely contains a reserved segment", () => {
      const parsed = organizationCreate.input.parse({
        name: "Login Co",
        slug: "login-co",
      });
      expect(parsed.slug).toBe("login-co");
    });

    it("refuses every reserved workspace slug at the workspace.slug path", () => {
      for (const slug of RESERVED_WORKSPACE_SLUGS) {
        const result = organizationCreate.input.safeParse({
          name: "Acme",
          slug: "acme",
          workspace: { name: "Shadow", slug },
        });
        expect(result.success, slug).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0]?.path).toEqual(["workspace", "slug"]);
        }
      }
    });

    // This list was hand-written and went stale the moment #3110 added
    // /{org}/roles: nothing updated it, so nothing failed, and the segment
    // shipped unguarded. The authoritative check reads the route directory
    // itself — apps/app/src/shared/reserved-route-segments.test.ts. This one
    // stays as the contract-side statement of the same invariant.
    it("covers the rev1 org-level route segments", () => {
      for (const segment of ["api-keys", "billing", "audit", "roles"]) {
        expect(RESERVED_WORKSPACE_SLUGS.has(segment), segment).toBe(true);
      }
    });
  });

  describe("first workspace", () => {
    it("defaults to the Default workspace when none is named", () => {
      const parsed = organizationCreate.input.parse({
        name: "Acme",
        slug: "acme",
      });
      expect(parsed.workspace).toEqual(DEFAULT_FIRST_WORKSPACE);
    });

    it("carries the named first workspace", () => {
      const parsed = organizationCreate.input.parse({
        name: "E2E",
        slug: "e2e-org",
        workspace: { name: "Core", slug: "core" },
      });
      expect(parsed.workspace).toEqual({ name: "Core", slug: "core" });
    });

    it("applies the slug rules to the workspace slug", () => {
      expect(() =>
        organizationCreate.input.parse({
          name: "Acme",
          slug: "acme",
          workspace: { name: "Core", slug: "Core Platform" },
        }),
      ).toThrow();
    });

    it("rejects a workspace with an empty name", () => {
      expect(() =>
        organizationCreate.input.parse({
          name: "Acme",
          slug: "acme",
          workspace: { name: "", slug: "core" },
        }),
      ).toThrow();
    });
  });

  it("is unscoped so a pre-tenant caller reaches it", () => {
    expect(organizationCreate.scoped).toBe(false);
  });

  describe("namespace", () => {
    it("is optional: left off, the handler derives one from the slug", () => {
      const parsed = organizationCreate.input.parse({
        name: "Acme",
        slug: "acme",
      });
      expect(parsed.namespace).toBeUndefined();
    });

    it("keeps the namespace the operator chose, verbatim", () => {
      const parsed = organizationCreate.input.parse({
        name: "Acme",
        slug: "acme",
        namespace: "aintel",
      });
      expect(parsed.namespace).toBe("aintel");
    });

    it.each(["a", "toolong", "a-intel", "ACME", "ac me"])(
      "rejects %j, which the organizations_namespace_check column refuses",
      (namespace) => {
        expect(() =>
          organizationCreate.input.parse({
            name: "Acme",
            slug: "acme",
            namespace,
          }),
        ).toThrow();
      },
    );
  });
});
