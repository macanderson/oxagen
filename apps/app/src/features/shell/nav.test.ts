import { describe, expect, it } from "vitest";
import {
  breadcrumbs,
  currentNavKey,
  isNavItemCurrent,
  orgHref,
  orgSegmentKey,
  parseShellPath,
  sidebarSections,
  visibleCount,
  workspaceHref,
} from "./nav";

const counts = {
  pendingApprovals: 2,
  agents: 38,
  openProposals: 0,
  openIncidents: 1,
};

describe("parseShellPath", () => {
  it("reads organization, workspace and the rest", () => {
    expect(parseShellPath("/acme/core-platform/runs/run_01")).toEqual({
      org: "acme",
      ws: "core-platform",
      rest: ["runs", "run_01"],
    });
  });

  it("treats the static organization segments as organization pages, not workspaces", () => {
    for (const segment of ["billing", "audit", "api-keys", "roles"])
      expect(parseShellPath(`/acme/${segment}`)).toEqual({
        org: "acme",
        ws: null,
        rest: [segment],
      });
  });

  it("does not mistake an object prototype key for an organization segment", () => {
    expect(orgSegmentKey("toString")).toBeNull();
    expect(orgSegmentKey("constructor")).toBeNull();
    expect(parseShellPath("/acme/toString").ws).toBe("toString");
  });

  it("ignores the query and hash, decodes segments and survives malformed escapes", () => {
    expect(parseShellPath("/acme/core%20platform?dialog=account#x").ws).toBe(
      "core platform",
    );
    expect(parseShellPath("/acme/%E0%A4%A").ws).toBe("%E0%A4%A");
  });

  it("has nothing outside an organization", () => {
    expect(parseShellPath("/")).toEqual({ org: null, ws: null, rest: [] });
    expect(parseShellPath("/acme")).toEqual({
      org: "acme",
      ws: null,
      rest: [],
    });
  });
});

describe("currentNavKey and isNavItemCurrent", () => {
  it.each([
    ["/acme", "organization"],
    ["/acme/billing", "billing"],
    ["/acme/audit/exports", "audit"],
    ["/acme/api-keys", "apiKeys"],
    ["/acme/roles", "roles"],
    ["/acme/core-platform", "fleet"],
    ["/acme/core-platform/runs/run_01/chain", "fleet"],
    ["/acme/core-platform/agents/acme.core.triage", "agents"],
    ["/acme/core-platform/tools/switches", "tools"],
    ["/acme/core-platform/ontology", "ontology"],
    ["/acme/core-platform/steering", "steering"],
    ["/acme/core-platform/spend/budgets", "spend"],
    ["/acme/core-platform/register", "register"],
  ])("%s → %s", (path, key) => {
    expect(currentNavKey(path)).toBe(key);
  });

  it("returns null outside the ten pages", () => {
    expect(currentNavKey("/")).toBeNull();
    expect(currentNavKey("/acme/core-platform/scenarios")).toBeNull();
  });

  it("marks Organization current for its API keys and roles pages", () => {
    expect(isNavItemCurrent("organization", "/acme/api-keys")).toBe(true);
    expect(isNavItemCurrent("organization", "/acme/roles")).toBe(true);
  });

  it("does not mark an item current on another page", () => {
    expect(isNavItemCurrent("fleet", "/acme/core-platform/agents")).toBe(false);
    expect(isNavItemCurrent("organization", "/acme/billing")).toBe(false);
  });
});

describe("hrefs", () => {
  it("builds every page route and encodes slugs", () => {
    expect(workspaceHref("acme", "core-platform", "fleet")).toBe(
      "/acme/core-platform",
    );
    expect(workspaceHref("acme", "core-platform", "agents")).toBe(
      "/acme/core-platform/agents",
    );
    expect(workspaceHref("acme", "a b", "register")).toBe(
      "/acme/a%20b/register",
    );
    expect(orgHref("acme", "organization")).toBe("/acme");
    expect(orgHref("acme", "apiKeys")).toBe("/acme/api-keys");
    expect(orgHref("acme", "roles")).toBe("/acme/roles");
  });

  it("refuses to build an organization href for a workspace page", () => {
    expect(() => orgHref("acme", "fleet")).toThrow(/workspace page/);
  });
});

describe("sidebarSections", () => {
  it("has the baseline sections, in order, with counts", () => {
    const sections = sidebarSections("acme", "core-platform", counts);
    expect(sections.map((s) => s.key)).toEqual(["workspace", "organization"]);
    expect(sections[0]?.items.map((i) => i.key)).toEqual([
      "fleet",
      "agents",
      "tools",
      "ontology",
      "steering",
      "spend",
    ]);
    expect(sections[1]?.items.map((i) => i.key)).toEqual([
      "organization",
      "billing",
      "audit",
    ]);
    const fleet = sections[0]?.items[0];
    expect(fleet).toMatchObject({
      href: "/acme/core-platform",
      count: 2,
      hot: true,
    });
    expect(sections[1]?.items[2]).toMatchObject({ count: 1, hot: true });
  });

  it("shows no count, never a zero, when counts are not recorded", () => {
    const sections = sidebarSections("acme", "core-platform", null);
    for (const item of sections.flatMap((s) => s.items))
      expect(item.count).toBeNull();
  });

  it("omits the workspace section when there is no workspace", () => {
    expect(sidebarSections("acme", null, counts).map((s) => s.key)).toEqual([
      "organization",
    ]);
  });

  it("draws only counts above zero", () => {
    expect(
      visibleCount({ key: "steering", href: "", count: 0, hot: false }),
    ).toBeNull();
    expect(
      visibleCount({ key: "steering", href: "", count: null, hot: false }),
    ).toBeNull();
    expect(
      visibleCount({ key: "steering", href: "", count: 3, hot: false }),
    ).toBe(3);
  });
});

describe("breadcrumbs", () => {
  const names = { org: "Acme Robotics", ws: "Core platform" };

  it("organization pages", () => {
    expect(breadcrumbs("/acme", names)).toEqual([
      { kind: "name", text: "Acme Robotics", href: "/acme" },
      { kind: "nav", key: "organization", href: null },
    ]);
    expect(breadcrumbs("/acme/api-keys", names)).toEqual([
      { kind: "name", text: "Acme Robotics", href: "/acme" },
      { kind: "nav", key: "organization", href: "/acme" },
      { kind: "nav", key: "apiKeys", href: null },
    ]);
    expect(breadcrumbs("/acme/billing", names).at(-1)).toEqual({
      kind: "nav",
      key: "billing",
      href: null,
    });
  });

  it("workspace pages", () => {
    expect(breadcrumbs("/acme/core-platform", names)).toEqual([
      { kind: "name", text: "Acme Robotics", href: "/acme" },
      { kind: "name", text: "Core platform", href: "/acme/core-platform" },
      { kind: "nav", key: "fleet", href: null },
    ]);
    expect(
      breadcrumbs("/acme/core-platform/runs/run_01", names).slice(2),
    ).toEqual([
      { kind: "nav", key: "fleet", href: "/acme/core-platform" },
      { kind: "id", text: "run_01", href: null },
    ]);
    expect(
      breadcrumbs("/acme/core-platform/tools/policy", names).at(-1),
    ).toEqual({
      kind: "nav",
      key: "tools",
      href: null,
    });
    expect(breadcrumbs("/acme/core-platform/register", names).at(-1)).toEqual({
      kind: "nav",
      key: "register",
      href: null,
    });
  });

  it("agent detail, source and mandate", () => {
    const agent = breadcrumbs(
      "/acme/core-platform/agents/acme.core.triage",
      names,
    );
    expect(agent.slice(2)).toEqual([
      { kind: "nav", key: "agents", href: "/acme/core-platform/agents" },
      { kind: "id", text: "acme.core.triage", href: null },
    ]);
    expect(
      breadcrumbs("/acme/core-platform/agents/a/source", names).slice(3),
    ).toEqual([
      { kind: "id", text: "a", href: "/acme/core-platform/agents/a" },
      { kind: "id", text: "source", href: null },
    ]);
    expect(
      breadcrumbs("/acme/core-platform/agents/a/mandates/mnd_1", names).at(-1),
    ).toEqual({ kind: "id", text: "mnd_1", href: null });
  });

  it("falls back to the slug for an unknown workspace name, and is empty outside an organization", () => {
    expect(breadcrumbs("/acme/finops", { org: "Acme", ws: null })[1]).toEqual({
      kind: "name",
      text: "finops",
      href: "/acme/finops",
    });
    expect(breadcrumbs("/", names)).toEqual([]);
    expect(breadcrumbs("/acme/core-platform/scenarios", names)).toHaveLength(2);
  });
});
