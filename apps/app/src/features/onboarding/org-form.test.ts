import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import onboardingMessages from "../../../messages/onboarding.json";
import { RESERVED_ORG_SLUGS } from "@oxagen/oxagen/contracts/org.create";
import { OrganizationForm, toSlug } from "./org-form";

describe("toSlug", () => {
  it("derives an address from a name", () => {
    expect(toSlug("Acme Robotics")).toBe("acme-robotics");
    expect(toSlug("  Ünïcode & Co.  ")).toBe("unicode-co");
    expect(toSlug(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
  });
});

describe("RESERVED_ORG_SLUGS", () => {
  it("covers every top-level route segment of the app", () => {
    const appDir = join(import.meta.dirname, "../../app");
    const segments = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        // A route group adds no segment; look inside it. Dynamic segments, private
        // folders and parallel-route slots are not names a URL can collide with.
        if (entry.name.startsWith("(")) walk(join(dir, entry.name));
        else if (!/^[[_@]/.test(entry.name)) segments.add(entry.name);
      }
    };
    walk(appDir);
    expect(segments.size).toBeGreaterThan(0);
    for (const segment of segments)
      expect(RESERVED_ORG_SLUGS.has(segment), segment).toBe(true);
  });

  it("leaves ordinary organization slugs free", () => {
    for (const slug of ["acme", "acme-robotics", "welcomed", "api-co"])
      expect(RESERVED_ORG_SLUGS.has(slug)).toBe(false);
  });
});

describe("OrganizationForm", () => {
  const valid = {
    name: "Acme Robotics",
    slug: "acme",
    workspaceName: "core-platform",
    workspaceSlug: "core-platform",
  };

  it("accepts a complete organization", () => {
    expect(OrganizationForm.safeParse(valid).success).toBe(true);
  });

  it.each([
    [{ slug: "Acme Robotics" }, "slug", "slugInvalid"],
    [{ slug: "new-organization" }, "slug", "slugReserved"],
    [{ slug: "login" }, "slug", "slugReserved"],
    [{ slug: "api" }, "slug", "slugReserved"],
    [{ slug: "invite" }, "slug", "slugReserved"],
    [{ name: "" }, "name", "orgNameRequired"],
    [{ workspaceSlug: "billing" }, "workspaceSlug", "workspaceSlugReserved"],
    [{ workspaceSlug: "-core" }, "workspaceSlug", "workspaceSlugInvalid"],
  ])("refuses %j", (patch, field, key) => {
    const r = OrganizationForm.safeParse({ ...valid, ...patch });
    expect(r.success).toBe(false);
    expect(r.error?.issues.find((i) => i.path[0] === field)?.message).toBe(key);
  });

  // `onboarding.errors` is the one catalog both onboarding forms raise keys
  // from, so the exhaustive check covers the register form's keys (agent-form.ts)
  // as well: a key either form can raise has copy, and the catalog carries no
  // copy no form can reach.
  it("every key either onboarding form raises, and both alerts, have catalog copy, and the catalog carries no other", () => {
    const keys = [
      "orgNameRequired",
      "orgNameTooLong",
      "slugInvalid",
      "slugReserved",
      "workspaceNameRequired",
      "workspaceNameTooLong",
      "workspaceSlugInvalid",
      "workspaceSlugReserved",
      "slugTaken",
      "agentSlugInvalid",
      "agentNameRequired",
      "agentNameTooLong",
      "agentDescriptionTooLong",
      "agentHarnessInvalid",
      "failed",
      "denied",
    ];
    expect(Object.keys(onboardingMessages.onboarding.errors).sort()).toEqual(
      [...keys].sort(),
    );
  });
});
