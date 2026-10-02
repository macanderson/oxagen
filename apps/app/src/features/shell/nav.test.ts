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
    // The Agents page's tabs are query values on its own path.
    ["/acme/core-platform/agents?tab=switches", "agents"],
    ["/acme/core-platform/agents?tab=runtimes", "agents"],
    // Tools and Runtimes are tabs of Agents: a Studio server's page, one
    // runtime's page and the retired paths that redirect all light Agents.
    ["/acme/core-platform/tools", "agents"],
    ["/acme/core-platform/tools/servers/mcs_01k5s1/try", "agents"],
    ["/acme/core-platform/steering", "steering"],
    ["/acme/core-platform/runtimes", "agents"],
    ["/acme/core-platform/runtimes/mbell-mbp-16", "agents"],
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
  it("has the mockup's eight links in order, Repositories between Steering and Spend, and Audit after Billing, and no Run, Skills, Tools, Runtimes or Ontology entry", () => {
    const sections = sidebarSections("acme", "core-platform");
    expect(sections.map((s) => s.key)).toEqual(["workspace", "organization"]);
    expect(sections.flatMap((s) => s.items)).toEqual([
      { key: "fleet", href: "/acme/core-platform" },
      { key: "agents", href: "/acme/core-platform/agents" },
      { key: "steering", href: "/acme/core-platform/steering" },
      { key: "repositories", href: "/acme/core-platform/repositories" },
      { key: "spend", href: "/acme/core-platform/spend" },
      { key: "organization", href: "/acme" },
      { key: "billing", href: "/acme/billing" },
      { key: "audit", href: "/acme/audit" },
    ]);
    for (const { href } of sections.flatMap((s) => s.items))
      expect(href).not.toMatch(/\/(ontology|runs|skills|tools|runtimes)(\/|$)/);
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
  it("split the eight sidebar keys: three slots, the rest in the sheet, each key once", () => {
    expect(THUMB_SLOTS).toEqual(["fleet", "agents", "spend"]);
    expect(MORE_SHEET).toEqual([
      "steering",
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
      "/acme/core-platform/repositories",
    ])
      expect(isMoreCurrent(path)).toBe(true);
  });

  it("does not mark More current on a thumb-bar page or outside the nav (negative)", () => {
    for (const path of [
      "/",
      "/acme/core-platform",
      // Tools and one runtime light Agents, a thumb-bar slot.
      "/acme/core-platform/agents?tab=runtimes",
      "/acme/core-platform/tools",
      "/acme/core-platform/runtimes/mbell-mbp-16",
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
    // A Studio server's page sits under Agents, which absorbed Tools.
    expect(
      breadcrumbs("/acme/core-platform/tools/servers/mcs_01k5s1", names).slice(
        2,
      ),
    ).toEqual([{ kind: "nav", key: "agents", href: null }]);
    // A tab of Agents is a query value, so its trail is the Agents page's.
    expect(
      breadcrumbs("/acme/core-platform/agents?tab=policies", names).slice(2),
    ).toEqual([{ kind: "nav", key: "agents", href: null }]);
  });

  it("agent detail and one of its tabs", () => {
    const agent = breadcrumbs(
      "/acme/core-platform/agents/acme.core.triage",
      names,
    );
    expect(agent.slice(2)).toEqual([
      { kind: "nav", key: "agents", href: "/acme/core-platform/agents" },
      { kind: "id", text: "acme.core.triage", href: null },
    ]);
    expect(
      breadcrumbs("/acme/core-platform/agents/a/toolbelt", names).slice(3),
    ).toEqual([{ kind: "id", text: "a", href: null }]);
  });

  it("one host sits under Agents, linked to its Runtimes tab, as a run sits under Fleet", () => {
    expect(
      breadcrumbs("/acme/core-platform/runtimes/mbell-mbp-16", names).slice(2),
    ).toEqual([
      {
        kind: "nav",
        key: "agents",
        href: "/acme/core-platform/agents?tab=runtimes",
      },
      { kind: "id", text: "mbell-mbp-16", href: null },
    ]);
  });

  it("one steering record ends on its declared label under Steering, and on its lineage until then", () => {
    const at = "/acme/core-platform/steering/records/ctx.release.no-reread";
    expect(breadcrumbs(at, names).slice(2)).toEqual([
      { kind: "nav", key: "steering", href: "/acme/core-platform/steering" },
      { kind: "id", text: "ctx.release.no-reread", href: null },
    ]);
    expect(
      breadcrumbs(at, {
        ...names,
        record: {
          id: "ctx.release.no-reread",
          label: "Read the changelog once",
        },
      }).slice(2),
    ).toEqual([
      { kind: "nav", key: "steering", href: "/acme/core-platform/steering" },
      { kind: "name", text: "Read the changelog once", href: null },
    ]);
    // A label another lineage declared never names this one.
    expect(
      breadcrumbs(at, {
        ...names,
        record: { id: "ctx.other", label: "Other" },
      }).at(-1),
    ).toEqual({ kind: "id", text: "ctx.release.no-reread", href: null });
    expect(
      breadcrumbs("/acme/core-platform/steering/records", names).slice(2),
    ).toEqual([{ kind: "nav", key: "steering", href: null }]);
  });

  it("one Context PR ends on its declared lineage under Steering's Proposals list (#5077)", () => {
    const at = "/acme/core-platform/steering/proposals/prs/prp_01k5ru4a";
    expect(breadcrumbs(at, names).slice(2)).toEqual([
      {
        kind: "nav",
        key: "steering",
        href: "/acme/core-platform/steering/proposals",
      },
      { kind: "id", text: "prp_01k5ru4a", href: null },
    ]);
    expect(
      breadcrumbs(at, {
        ...names,
        record: { id: "prp_01k5ru4a", label: "ctx.release.no-reread" },
      }).at(-1),
    ).toEqual({ kind: "id", text: "ctx.release.no-reread", href: null });
    expect(
      breadcrumbs("/acme/core-platform/steering/proposals", names).slice(2),
    ).toEqual([{ kind: "nav", key: "steering", href: null }]);
  });

  it("mandate, on its flat route (not nested under the agent)", () => {
    expect(
      breadcrumbs("/acme/core-platform/mandates/mnd_1", names).slice(2),
    ).toEqual([
      { kind: "nav", key: "agents", href: "/acme/core-platform/agents" },
      { kind: "id", text: "mnd_1", href: null },
    ]);
  });

  it("the retired runtimes path ends on Agents, and one runtime ends on its id under the Runtimes tab's link", () => {
    expect(breadcrumbs("/acme/core-platform/runtimes", names).slice(2)).toEqual(
      [{ kind: "nav", key: "agents", href: null }],
    );
    expect(
      breadcrumbs("/acme/core-platform/runtimes/tch_1", names).slice(2),
    ).toEqual([
      {
        kind: "nav",
        key: "agents",
        href: "/acme/core-platform/agents?tab=runtimes",
      },
      { kind: "id", text: "tch_1", href: null },
    ]);
  });

  it("one runtime ends on the name its page declared for that id, and never on another id's name", () => {
    const at = "/acme/core-platform/runtimes/tch_1";
    expect(
      breadcrumbs(at, {
        ...names,
        record: { id: "tch_1", label: "mbell-mbp-16" },
      }).at(-1),
    ).toEqual({ kind: "id", text: "mbell-mbp-16", href: null });
    // A declaration left by the runtime being navigated away from names
    // another host, so the id stands in until this page declares its own.
    expect(
      breadcrumbs(at, {
        ...names,
        record: { id: "tch_2", label: "ci-runner-07" },
      }).at(-1),
    ).toEqual({ kind: "id", text: "tch_1", href: null });
    expect(
      breadcrumbs(at, { ...names, record: { id: "tch_1", label: null } }).at(
        -1,
      ),
    ).toEqual({ kind: "id", text: "tch_1", href: null });
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
