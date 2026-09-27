import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import onboardingMessages from "../../../messages/onboarding.json";
import { RESERVED_ORG_SLUGS } from "@oxagen/oxagen/contracts/org.create";
import { OrganizationForm, toNamespace, toSlug } from "./org-form";

describe("toSlug", () => {
  it("derives an address from a name", () => {
    expect(toSlug("Acme Robotics")).toBe("acme-robotics");
    expect(toSlug("  Ünïcode & Co.  ")).toBe("unicode-co");
    expect(toSlug(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
  });

  it("drops apostrophes and other special characters rather than hyphenating them (ADR-198)", () => {
    expect(toSlug("Mac's Robotics")).toBe("macs-robotics");
    expect(toSlug("R&D Labs")).toBe("rd-labs");
  });
});

describe("toNamespace", () => {
  it("suggests the name's letters and digits, at most six", () => {
    expect(toNamespace("Anderson Intelligence Corp.")).toBe("anders");
    expect(toNamespace("A-1 Co")).toBe("a1co");
    expect(toNamespace("Ünï")).toBe("uni");
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
    namespace: "acme",
  };

  it("accepts a complete organization", () => {
    expect(OrganizationForm.safeParse(valid).success).toBe(true);
  });

  // The first workspace is its own step after Connect (lane S7, #4518): a
  // workspace needs a steering repo, and the organization form comes before
  // any code host is connected.
  it("names no workspace field", () => {
    expect(OrganizationForm.keyof().options).toEqual([
      "name",
      "slug",
      "namespace",
    ]);
    const parsed = OrganizationForm.safeParse({
      ...valid,
      workspaceName: "Core platform",
      workspaceSlug: "core-platform",
    });
    expect(parsed.success && Object.keys(parsed.data)).toEqual([
      "name",
      "slug",
      "namespace",
    ]);
  });

  it.each([
    [{ slug: "Acme Robotics" }, "slug", "slugInvalid"],
    [{ slug: "new-organization" }, "slug", "slugReserved"],
    [{ slug: "login" }, "slug", "slugReserved"],
    [{ slug: "api" }, "slug", "slugReserved"],
    [{ slug: "invite" }, "slug", "slugReserved"],
    [{ name: "" }, "name", "orgNameRequired"],
    [{ namespace: "a" }, "namespace", "namespaceInvalid"],
    [{ namespace: "a-intel" }, "namespace", "namespaceInvalid"],
    [{ namespace: "toolong" }, "namespace", "namespaceInvalid"],
    [{ namespace: "ACME" }, "namespace", "namespaceInvalid"],
  ])("refuses %j", (patch, field, key) => {
    const r = OrganizationForm.safeParse({ ...valid, ...patch });
    expect(r.success).toBe(false);
    expect(r.error?.issues.find((i) => i.path[0] === field)?.message).toBe(key);
  });

  // `onboarding.errors` is the one catalog both onboarding forms raise keys
  // from, so the exhaustive check covers the register form's keys (agent-form.ts)
  // as well: a key either form can raise has copy, and the catalog carries no
  // copy no form can reach. A taken namespace is the one exception: its copy
  // is `organization.namespaceTaken`, the alert above the fields, so the
  // field itself is only marked bad.
  it("every key either onboarding form raises, and the failure alert, have catalog copy, and the catalog carries no other", () => {
    const keys = [
      "orgNameRequired",
      "orgNameTooLong",
      "slugInvalid",
      "slugReserved",
      "namespaceInvalid",
      "slugTaken",
      "agentSlugInvalid",
      "agentNameRequired",
      "agentNameTooLong",
      "agentHarnessInvalid",
      // ADR-198: the runtime the agent runs on, and the two refusals the
      // register form names on a field rather than in the alert.
      "agentRuntimeRequired",
      "agentSlugTaken",
      "agentRuntimeHarnessTaken",
      "failed",
    ];
    expect(Object.keys(onboardingMessages.onboarding.errors).sort()).toEqual(
      [...keys].sort(),
    );
  });
});
