import { describe, expect, it } from "vitest";
import { organizationCreate } from "./contracts/org.create";
import { workspaceCreate } from "./contracts/workspace.create";
import { workspaceSettingsWrite } from "./contracts/workspace.settings.write";
import {
  RESERVED_WORKSPACE_SLUGS,
  WORKSPACE_SLUG_MAX,
  WORKSPACE_SLUG_MIN,
  WORKSPACE_SLUG_PATTERN,
  slugFromName,
  workspaceSlug,
} from "./workspace-slug";

/** Every contract field in the tree that accepts a workspace slug. */
const slugFields = [
  [
    "create_workspace",
    (slug: string) =>
      workspaceCreate.input.parse({
        name: "Team",
        slug,
        // Required since M0 (ADR-099); a valid repository so this fixture
        // still isolates the slug.
        mainRepo: { owner: "acme", name: "platform" },
      }),
  ],
  [
    "update_workspace_settings",
    (slug: string) => workspaceSettingsWrite.input.parse({ slug }),
  ],
  [
    "create_org (first workspace)",
    (slug: string) =>
      organizationCreate.input.parse({
        name: "Acme",
        slug: "acme",
        workspace: { name: "Team", slug },
      }),
  ],
] as const;

describe("workspaceSlug", () => {
  it("takes lowercase letters and digits in single-hyphen groups", () => {
    for (const ok of ["team", "team-one", "t3am-2", "ab"]) {
      expect(workspaceSlug.parse(ok), ok).toBe(ok);
    }
  });

  it("refuses the spellings the loose pattern used to admit", () => {
    // `^[a-z0-9-]+$` took all three; `update_workspace_settings` never did, so
    // a workspace created with one could not be edited afterwards.
    for (const bad of ["team--one", "team-", "-team"]) {
      expect(() => workspaceSlug.parse(bad), bad).toThrow();
    }
  });

  it("refuses uppercase, spaces and anything outside the alphabet", () => {
    for (const bad of ["Team", "team one", "team_one", "team.one", "téam"]) {
      expect(() => workspaceSlug.parse(bad), bad).toThrow();
    }
  });

  it("holds the length bounds", () => {
    expect(() => workspaceSlug.parse("a")).toThrow();
    expect(workspaceSlug.parse("a".repeat(WORKSPACE_SLUG_MIN))).toHaveLength(
      WORKSPACE_SLUG_MIN,
    );
    expect(workspaceSlug.parse("a".repeat(WORKSPACE_SLUG_MAX))).toHaveLength(
      WORKSPACE_SLUG_MAX,
    );
    expect(() =>
      workspaceSlug.parse("a".repeat(WORKSPACE_SLUG_MAX + 1)),
    ).toThrow();
  });

  it("refuses every reserved org-route segment", () => {
    for (const reserved of RESERVED_WORKSPACE_SLUGS) {
      expect(() => workspaceSlug.parse(reserved), reserved).toThrow();
    }
  });
});

describe("every contract that accepts a workspace slug takes the same one", () => {
  // The defect this replaces: three fields, three spellings. A workspace could
  // be created at `roles` and shadow `/{org}/roles`, or created as `team--one`
  // and then be refused by every later edit for a field the editor never
  // touched. One shape means neither can come back one contract at a time.
  it.each(slugFields)("%s refuses a reserved segment", (_name, parse) => {
    expect(() => parse("roles")).toThrow();
    expect(() => parse("api-keys")).toThrow();
    expect(() => parse("billing")).toThrow();
  });

  it.each(slugFields)("%s refuses a doubled hyphen", (_name, parse) => {
    expect(() => parse("team--one")).toThrow();
  });

  it.each(slugFields)("%s refuses a trailing hyphen", (_name, parse) => {
    expect(() => parse("team-")).toThrow();
  });

  it.each(slugFields)("%s takes a plain slug", (_name, parse) => {
    expect(() => parse("team-one")).not.toThrow();
  });
});

describe("slugFromName", () => {
  it.each([
    ["Mac's Laptop", "macs-laptop"],
    ["Mac’s Laptop", "macs-laptop"],
    ["R&D box", "rd-box"],
    ["  Build   Runner  ", "build-runner"],
    ["build - runner", "build-runner"],
    ["Café Staging", "cafe-staging"],
    ["gpu_01.local", "gpu01local"],
    ["123", "123"],
  ])("derives %j as %j", (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
    expect(slug).toMatch(WORKSPACE_SLUG_PATTERN);
  });

  it("returns an empty slug for a name with no letter or digit", () => {
    expect(slugFromName("'&!")).toBe("");
  });

  it("cuts to the limit without leaving a trailing hyphen", () => {
    expect(slugFromName("abcdefghij klmnopq", 11)).toBe("abcdefghij");
    expect(slugFromName("a".repeat(60))).toHaveLength(WORKSPACE_SLUG_MAX);
  });
});
