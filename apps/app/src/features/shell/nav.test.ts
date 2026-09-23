import { describe, expect, it } from "vitest";
import {
  breadcrumbs,
  isMoreCurrent,
  isNavItemCurrent,
  MORE_SHEET,
  type NavKey,
  ORG_NAV,
  orgHref,
  parseShellPath,
  sidebarSections,
  THUMB_SLOTS,
  WORKSPACE_NAV,
  workspaceHref,
} from "./nav";

const ALL_KEYS: readonly NavKey[] = [
  ...WORKSPACE_NAV,
  ...ORG_NAV,
  "apiKeys",
  "roles",
  "modelFunding",
  "sso",
];

describe("parseShellPath", () => {
  it("reads organization, workspace and the rest", () => {
    expect(parseShellPath("/acme/core-platform/runs/run_01")).toEqual({
      org: "acme",
      ws: "core-platform",
      rest: ["runs", "run_01"],
    });
  });

  it("treats the static organization segments as organization pages, not workspaces", () => {
    for (const segment of [
      "billing",
      "audit",
      "api-keys",
      "roles",
      "model-funding",
      "sso",
    ])
      expect(parseShellPath(`/acme/${segment}`)).toEqual({
        org: "acme",
        ws: null,
        rest: [segment],
      });
  });

  it("does not mistake an object prototype key for an organization segment", () => {
    expect(parseShellPath("/acme/toString").ws).toBe("toString");
    expect(parseShellPath("/acme/constructor").ws).toBe("constructor");
  });

  it("ignores the query and hash, decodes segments and survives malformed escapes", () => {
    expect(parseShellPath("/acme/core%20platform?tab=x#y").ws).toBe(
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

describe("isNavItemCurrent", () => {
  it.each([
    ["/acme", "organization"],
    ["/acme/billing", "billing"],
    ["/acme/audit", "audit"],
    ["/acme/api-keys", "apiKeys"],
    ["/acme/model-funding", "modelFunding"],
    ["/acme/sso", "sso"],
    ["/acme/roles", "roles"],
    ["/acme/core-platform", "fleet"],
    ["/acme/core-platform/runs/run_01/chain", "fleet"],
    ["/acme/core-platform/agents/acme.core.triage", "agents"],
    ["/acme/core-platform/tools/switches", "tools"],
    ["/acme/core-platform/steering", "steering"],
    ["/acme/core-platform/runtimes", "runtimes"],
    ["/acme/core-platform/runtimes/tch_1", "runtimes"],
    ["/acme/core-platform/repositories", "repositories"],
    ["/acme/core-platform/repositories/changes", "repositories"],
    ["/acme/core-platform/spend/budgets", "spend"],
    // Flat route, no sidebar item of its own: lights Agents, the same way
    // `runs/{run}` with no Runs item lights Fleet.
    ["/acme/core-platform/mandates/mnd_1", "agents"],
  ] as const)("%s → %s", (path, key) => {
    expect(
      ALL_KEYS.filter((k) => k !== "organization" && isNavItemCurrent(k, path)),
    ).toEqual(key === "organization" ? [] : [key]);
    expect(isNavItemCurrent("organization", path)).toBe(
      key === "organization" ||
        key === "apiKeys" ||
        key === "roles" ||
        key === "modelFunding" ||
        key === "sso",
    );
  });

  it("marks nothing current on a path no nav item holds, Ontology's and the retired Skills page's included (negative)", () => {
    for (const path of [
      "/",
      "/acme/core-platform/scenarios",
      "/acme/core-platform/ontology",
    ])
      expect(ALL_KEYS.filter((k) => isNavItemCurrent(k, path))).toEqual([]);
  });

  it("marks Organization current for its API keys and Roles pages", () => {
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
    expect(workspaceHref("acme", "a b", "agents")).toBe("/acme/a%20b/agents");
    expect(orgHref("acme", "organization")).toBe("/acme");
    expect(orgHref("acme", "audit")).toBe("/acme/audit");
    expect(orgHref("acme", "apiKeys")).toBe("/acme/api-keys");
    expect(orgHref("acme", "modelFunding")).toBe("/acme/model-funding");
    expect(orgHref("acme", "sso")).toBe("/acme/sso");
    expect(orgHref("acme", "roles")).toBe("/acme/roles");
  });

  it("refuses to build an organization href for a workspace page", () => {
    expect(() => orgHref("acme", "fleet")).toThrow(/workspace page/);
  });
});

describe("sidebarSections", () => {
  it("has the mockup's ten links in order, Runtimes between Steering and Repositories, Repositories before Spend, and Audit after Billing, and no Run or Ontology entry", () => {
    const sections = sidebarSections("acme", "core-platform");
    expect(sections.map((s) => s.key)).toEqual(["workspace", "organization"]);
    expect(sections.flatMap((s) => s.items)).toEqual([
      { key: "fleet", href: "/acme/core-platform" },
      { key: "agents", href: "/acme/core-platform/agents" },
      { key: "tools", href: "/acme/core-platform/tools" },
      { key: "steering", href: "/acme/core-platform/steering" },
      { key: "runtimes", href: "/acme/core-platform/runtimes" },
      { key: "repositories", href: "/acme/core-platform/repositories" },
      { key: "spend", href: "/acme/core-platform/spend" },
      { key: "organization", href: "/acme" },
      { key: "billing", href: "/acme/billing" },
      { key: "audit", href: "/acme/audit" },
    ]);
    for (const { href } of sections.flatMap((s) => s.items))
      expect(href).not.toMatch(/\/(ontology|runs|skills)(\/|$)/);
  });

  it("carries a key and an href per item and nothing else (negative)", () => {
    for (const item of sidebarSections("acme", "core-platform").flatMap(
      (s) => s.items,
    ))
      expect(Object.keys(item).sort()).toEqual(["href", "key"]);
  });

  it("omits the workspace section when there is no workspace", () => {
    expect(sidebarSections("acme", null).map((s) => s.key)).toEqual([
      "organization",
    ]);
  });
});

describe("the phone's thumb bar and More sheet", () => {
  it("split the ten sidebar keys: four slots, the rest in the sheet, each key once", () => {
    expect(THUMB_SLOTS).toEqual(["fleet", "agents", "tools", "spend"]);
    expect(MORE_SHEET).toEqual([
      "steering",
      "runtimes",
      "repositories",
      "organization",
      "billing",
      "audit",
    ]);
    expect([...THUMB_SLOTS, ...MORE_SHEET].sort()).toEqual(
      [...WORKSPACE_NAV, ...ORG_NAV].sort(),
    );
  });

  it("marks More current on a page the sheet holds, API keys under Organization included", () => {
    for (const path of [
      "/acme",
      "/acme/api-keys",
      "/acme/roles",
      "/acme/billing",
      "/acme/audit",
      "/acme/core-platform/steering",
      "/acme/core-platform/runtimes",
      "/acme/core-platform/runtimes/tch_1",
      "/acme/core-platform/repositories",
    ])
      expect(isMoreCurrent(path)).toBe(true);
  });

  it("does not mark More current on a thumb-bar page or outside the nav (negative)", () => {
    for (const path of [
      "/",
      "/acme/core-platform",
      "/acme/core-platform/tools",
      "/acme/core-platform/spend",
    ])
      expect(isMoreCurrent(path)).toBe(false);
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
    expect(breadcrumbs("/acme/roles", names)).toEqual([
      { kind: "name", text: "Acme Robotics", href: "/acme" },
      { kind: "nav", key: "organization", href: "/acme" },
      { kind: "nav", key: "roles", href: null },
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
  });

  it("agent detail and source", () => {
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
  });

  it("mandate, on its flat route (not nested under the agent)", () => {
    expect(
      breadcrumbs("/acme/core-platform/mandates/mnd_1", names).slice(2),
    ).toEqual([
      { kind: "nav", key: "agents", href: "/acme/core-platform/agents" },
      { kind: "id", text: "mnd_1", href: null },
    ]);
  });

  it("runtimes ends on Runtimes, and one runtime ends on its id under a Runtimes link", () => {
    expect(breadcrumbs("/acme/core-platform/runtimes", names).slice(2)).toEqual(
      [{ kind: "nav", key: "runtimes", href: null }],
    );
    expect(
      breadcrumbs("/acme/core-platform/runtimes/tch_1", names).slice(2),
    ).toEqual([
      { kind: "nav", key: "runtimes", href: "/acme/core-platform/runtimes" },
      { kind: "id", text: "tch_1", href: null },
    ]);
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
