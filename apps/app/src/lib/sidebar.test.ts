/**
 * sidebar.test.ts — real assertions against the navigation config.
 *
 * Tests:
 *   1. resolveSidebarMode: correct mode for sample paths
 *   2. getSidebarConfig: item counts per mode match the spec
 *   3. href builders: produce correct concrete paths for a sample ctx
 *   4. enumerateNavTargets: flattens workspace + org + account destinations
 */

import { describe, it, expect } from "vitest";
import {
  resolveSidebarMode,
  resolveSidebarCtx,
  activeHrefFor,
  getSidebarConfig,
  enumerateNavTargets,
  ORG_SCOPE_ROUTES,
  type SidebarMode,
} from "./sidebar";
import type { ScopeContext } from "./scope";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const wsCtx: ScopeContext = { orgSlug: "acme", workspaceSlug: "production" };
const orgCtx: ScopeContext = { orgSlug: "acme" };

// ---------------------------------------------------------------------------
// 1. resolveSidebarMode
// ---------------------------------------------------------------------------

describe("resolveSidebarMode", () => {
  it("returns 'account' for /account/* paths regardless of ctx", () => {
    expect(resolveSidebarMode("/account/profile", wsCtx)).toBe(
      "account" satisfies SidebarMode,
    );
    expect(resolveSidebarMode("/account/security", orgCtx)).toBe("account");
    expect(resolveSidebarMode("/account", wsCtx)).toBe("account");
  });

  it("returns 'workspace' when workspaceSlug is present and path is not /account", () => {
    expect(resolveSidebarMode("/acme/production/ask", wsCtx)).toBe("workspace");
    expect(
      resolveSidebarMode("/acme/production/knowledge/sources", wsCtx),
    ).toBe("workspace");
  });

  it("returns 'workspace' from pathname when ctx has no workspaceSlug (org-layout boundary)", () => {
    // The AppShell at the org layout level has no workspaceSlug in ctx.
    // resolveSidebarMode must derive workspace mode purely from the URL.
    expect(resolveSidebarMode("/acme/production/ask", orgCtx)).toBe(
      "workspace",
    );
    expect(
      resolveSidebarMode("/acme/production/settings/general", orgCtx),
    ).toBe("workspace");
    expect(resolveSidebarMode("/acme/my-ws/knowledge", orgCtx)).toBe(
      "workspace",
    );
  });

  it("returns 'org' for reserved org-scope routes even without workspaceSlug", () => {
    expect(resolveSidebarMode("/acme/members", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/governance", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/access", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/security", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/billing", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/developer", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/settings", orgCtx)).toBe("org");
  });

  it("returns 'org' when no workspaceSlug and path is not /account", () => {
    expect(resolveSidebarMode("/acme", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/members", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/billing/subscription", orgCtx)).toBe(
      "org",
    );
  });

  it("account mode takes priority over workspace ctx", () => {
    // Even if workspaceSlug is present, /account prefix wins.
    expect(resolveSidebarMode("/account/security", wsCtx)).toBe("account");
  });
});

// ---------------------------------------------------------------------------
// 2. getSidebarConfig — item counts per mode
//
// Spec:
//   workspace: 9 items (Ask, Knowledge, Evals | Agents, Agent Tools,
//       Environments, Sandboxes | Marketplace, Settings)
//     — Evals scores what actually ran and got billed, in the primary group.
//       The Workbench "tools" group holds all four build destinations (Agents,
//       Agent Tools, Environments, Sandboxes) as first-class items — there is
//       deliberately NO Workbench secondary nav. Marketplace + Settings are
//       pinned to the footer group. The old catch-all Automation area stays
//       removed; "Workflows" is gone too (banned term). The Activity run-trace
//       section was removed as well — agent runs are inspected in context
//       (chat, evals) rather than in a standalone list.
//   org:       8 items (Dashboard, Workspaces, Members, Governance, Security, Billing, Developer, Settings)
//   account:   5 items (Back to app, Profile, Preferences, Security, Privacy)
// ---------------------------------------------------------------------------

describe("getSidebarConfig item counts", () => {
  it("workspace config has exactly 12 items", () => {
    const config = getSidebarConfig("workspace");
    expect(config.mode).toBe("workspace");
    // web-app-2.0 added Overview, Automations, and Repos to the base; the
    // Activity run-trace surface was later removed (runs are inspected in
    // context — chat, evals — not in a standalone section).
    expect(config.items).toHaveLength(12);
  });

  it("org config has 8 items by default (access filtered for non-enterprise)", () => {
    const config = getSidebarConfig("org");
    expect(config.mode).toBe("org");
    // web-app-2.0 added Governance; the usage-analytics work added Dashboard as
    // the first org item (the org home / redirect target of `/{org}`).
    expect(config.items).toHaveLength(8);
  });

  it("org config has 9 items for enterprise", () => {
    const config = getSidebarConfig("org", "enterprise");
    expect(config.mode).toBe("org");
    expect(config.items).toHaveLength(9);
  });

  it("account config has exactly 5 items", () => {
    const config = getSidebarConfig("account");
    expect(config.mode).toBe("account");
    expect(config.items).toHaveLength(5);
  });

  it("account config contains exactly one isReturn item", () => {
    const items = getSidebarConfig("account").items;
    const returnItems = items.filter((item) => item.isReturn === true);
    expect(returnItems).toHaveLength(1);
    expect(returnItems[0]?.id).toBe("back");
  });

  it("workspace config 'tools' group holds the five first-class Workbench destinations", () => {
    const items = getSidebarConfig("workspace").items;
    const toolsItems = items.filter((item) => item.group === "tools");
    expect(toolsItems.map((i) => i.id)).toEqual([
      "agents",
      "agent-tools",
      "environments",
      "sandboxes",
      "repos",
    ]);
  });

  it("does NOT surface standalone Skills / Tools / Subagent Runs / Workflows items", () => {
    const ids = getSidebarConfig("workspace").items.map((i) => i.id);
    // Skills and Tools collapsed into the single Agent Tools hub.
    expect(ids).not.toContain("skills");
    expect(ids).not.toContain("tools");
    expect(ids).not.toContain("agent-runs");
    // Workflows is a tab under Automations, not a standalone sidebar item.
    expect(ids).not.toContain("workflows");
    // The clean spec tree, in raw declaration order (the mobile bottom bar's
    // unfiltered MAX_BAR_ITEMS cut relies on this exact order — see
    // mobile-bottom-bar.tsx). Evals (group: "primary") is declared after
    // "agents" so it renders in the desktop sidebar's group-filtered view (see
    // the "workspace config 'tools' group" test below) without displacing
    // Agents from the mobile bar's first four; the Workbench "tools" group then
    // promotes all four build destinations (Agents, Agent Tools, Environments,
    // Sandboxes) to the sidebar.
    expect(ids).toEqual([
      "overview",
      "sessions",
      "knowledge",
      "automations",
      "agents",
      "evals",
      "agent-tools",
      "environments",
      "sandboxes",
      "repos",
      "marketplace",
      "settings",
    ]);
  });

  it("workspace config has exactly two 'footer' group items (Marketplace, Settings)", () => {
    const items = getSidebarConfig("workspace").items;
    const footerItems = items.filter((item) => item.group === "footer");
    expect(footerItems).toHaveLength(2);
    const ids = footerItems.map((i) => i.id);
    expect(ids).toContain("marketplace");
    expect(ids).toContain("settings");
  });

  it("org config 'workspaces' item links to the org workspaces listing", () => {
    const items = getSidebarConfig("org").items;
    const workspacesItem = items.find((item) => item.id === "workspaces");
    // No longer an external mode-jump: it lands on a real in-org listing page,
    // so the ↗ affordance would be misleading.
    expect(workspacesItem?.external).toBeUndefined();
    expect(workspacesItem?.href({ orgSlug: "acme" })).toBe("/acme/workspaces");
  });

  it("org config has exactly one 'footer' group item (Settings)", () => {
    const items = getSidebarConfig("org").items;
    const footerItems = items.filter((item) => item.group === "footer");
    expect(footerItems).toHaveLength(1);
    expect(footerItems[0]?.id).toBe("org-settings");
  });
});

// ---------------------------------------------------------------------------
// 3. href builders — concrete paths for sample ctx
// ---------------------------------------------------------------------------

describe("href builders produce correct paths", () => {
  describe("workspace mode", () => {
    const config = getSidebarConfig("workspace");
    const findItem = (id: string) => config.items.find((i) => i.id === id)!;

    it("sessions -> /{org}/{ws}/sessions", () => {
      expect(findItem("sessions").href(wsCtx)).toBe(
        "/acme/production/sessions",
      );
    });

    it("knowledge -> /{org}/{ws}/knowledge", () => {
      expect(findItem("knowledge").href(wsCtx)).toBe(
        "/acme/production/knowledge",
      );
    });

    it("evals -> /{org}/{ws}/evals", () => {
      expect(findItem("evals").href(wsCtx)).toBe("/acme/production/evals");
    });

    it("marketplace -> /{org}/{ws}/marketplace (workspace-scoped, from ws ctx)", () => {
      expect(findItem("marketplace").href(wsCtx)).toBe(
        "/acme/production/marketplace",
      );
    });

    it("agents -> /{org}/{ws}/workbench/agents", () => {
      expect(findItem("agents").href(wsCtx)).toBe(
        "/acme/production/workbench/agents",
      );
    });

    it("agent-tools -> /{org}/{ws}/workbench/tools", () => {
      expect(findItem("agent-tools").href(wsCtx)).toBe(
        "/acme/production/workbench/tools",
      );
    });

    it("environments -> /{org}/{ws}/workbench/environments", () => {
      expect(findItem("environments").href(wsCtx)).toBe(
        "/acme/production/workbench/environments",
      );
    });

    it("sandboxes -> /{org}/{ws}/workbench/sandboxes", () => {
      expect(findItem("sandboxes").href(wsCtx)).toBe(
        "/acme/production/workbench/sandboxes",
      );
    });

    it("settings -> /{org}/{ws}/settings", () => {
      expect(findItem("settings").href(wsCtx)).toBe(
        "/acme/production/settings",
      );
    });

    it("overview -> /{org}/{ws} (workspace root, web-app-2.0)", () => {
      expect(findItem("overview").href(wsCtx)).toBe("/acme/production");
    });

    it("automations -> /{org}/{ws}/automations (web-app-2.0)", () => {
      expect(findItem("automations").href(wsCtx)).toBe(
        "/acme/production/automations",
      );
    });

    it("repos -> /{org}/{ws}/workbench/repos (web-app-2.0)", () => {
      expect(findItem("repos").href(wsCtx)).toBe(
        "/acme/production/workbench/repos",
      );
    });
  });

  describe("org mode", () => {
    const config = getSidebarConfig("org", "enterprise");
    const findItem = (id: string) => config.items.find((i) => i.id === id)!;

    it("workspaces -> /{org}/workspaces", () => {
      expect(findItem("workspaces").href(orgCtx)).toBe("/acme/workspaces");
    });

    it("members -> /{org}/members", () => {
      expect(findItem("members").href(orgCtx)).toBe("/acme/members");
    });

    it("governance -> /{org}/governance (web-app-2.0)", () => {
      expect(findItem("governance").href(orgCtx)).toBe("/acme/governance");
    });

    it("access -> /{org}/access (enterprise only)", () => {
      expect(findItem("access").href(orgCtx)).toBe("/acme/access");
    });

    it("security -> /{org}/security", () => {
      expect(findItem("security").href(orgCtx)).toBe("/acme/security");
    });

    it("billing -> /{org}/billing", () => {
      expect(findItem("billing").href(orgCtx)).toBe("/acme/billing");
    });

    it("developer -> /{org}/developer", () => {
      expect(findItem("developer").href(orgCtx)).toBe("/acme/developer");
    });

    it("org-settings -> /{org}/settings/general", () => {
      expect(findItem("org-settings").href(orgCtx)).toBe(
        "/acme/settings/general",
      );
    });
  });

  describe("account mode", () => {
    const config = getSidebarConfig("account");
    const findItem = (id: string) => config.items.find((i) => i.id === id)!;

    it("back with workspaceSlug -> /{org}/{ws}/sessions", () => {
      expect(findItem("back").href(wsCtx)).toBe("/acme/production/sessions");
    });

    it("back without workspaceSlug -> /{org}", () => {
      expect(findItem("back").href(orgCtx)).toBe("/acme");
    });

    it("profile -> /account/profile", () => {
      expect(findItem("profile").href(wsCtx)).toBe("/account/profile");
    });
  });
});

// ---------------------------------------------------------------------------
// 4. enumerateNavTargets
// ---------------------------------------------------------------------------

describe("enumerateNavTargets", () => {
  it("includes workspace-specific paths when workspaceSlug is present", () => {
    const targets = enumerateNavTargets(wsCtx);
    const hrefs = targets.map((t) => t.href);

    // Spot-check a workspace path and a tab path
    expect(hrefs).toContain("/acme/production/sessions");
    expect(hrefs).toContain("/acme/production/knowledge/sources");
    expect(hrefs).toContain("/acme/production/settings");

    // web-app-2.0 Phase 2 nav restructure: the renamed/merged targets are
    // present and the old ones are gone.
    expect(hrefs).toContain("/acme/production/knowledge/graph");
    expect(hrefs).toContain("/acme/production/knowledge/ontology");
    expect(hrefs).toContain("/acme/production/knowledge/memory");
    expect(hrefs).toContain("/acme/production/settings/agent-defaults");
    expect(hrefs).not.toContain("/acme/production/knowledge/repos");
    expect(hrefs).not.toContain("/acme/production/knowledge/explore");
    expect(hrefs).not.toContain("/acme/production/settings/models");
  });

  it("includes org paths regardless of workspaceSlug", () => {
    const targetsWithWs = enumerateNavTargets(wsCtx);
    const targetsOrgOnly = enumerateNavTargets(orgCtx);

    for (const targets of [targetsWithWs, targetsOrgOnly]) {
      const hrefs = targets.map((t) => t.href);
      expect(hrefs).toContain("/acme/access");
      expect(hrefs).toContain("/acme/access/sessions");
      expect(hrefs).toContain("/acme/access/reviews");
      expect(hrefs).toContain("/acme/security/audit");
      expect(hrefs).toContain("/acme/billing/subscription");
      expect(hrefs).toContain("/acme/developer/mcp");
    }
  });

  it("includes account paths regardless of ctx", () => {
    const targets = enumerateNavTargets(orgCtx);
    const hrefs = targets.map((t) => t.href);

    expect(hrefs).toContain("/account/profile");
  });

  it("does NOT include workspace paths when workspaceSlug is absent", () => {
    const targets = enumerateNavTargets(orgCtx);
    const hrefs = targets.map((t) => t.href);

    expect(hrefs).not.toContain("/acme/production/sessions");
    expect(hrefs).not.toContain("/acme/production/knowledge/sources");
  });

  it("all entries have non-empty label and href", () => {
    const targets = enumerateNavTargets(wsCtx);
    for (const t of targets) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.href.startsWith("/")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. resolveSidebarCtx — recover workspaceSlug from the URL (the "all rows
//    active / broken nav" regression: the org layout mounts the shell with no
//    workspaceSlug, collapsing every workspace href to the org root).
// ---------------------------------------------------------------------------

describe("resolveSidebarCtx", () => {
  it("recovers workspaceSlug from the URL so workspace hrefs do not collapse", () => {
    const eff = resolveSidebarCtx("/acme/production/knowledge/sources", orgCtx);
    expect(eff.workspaceSlug).toBe("production");

    // Regression: before the fix every item's href fell back to "/acme".
    const hrefs = getSidebarConfig("workspace").items.map((item) =>
      item.href(eff),
    );
    expect(hrefs.every((h) => h === "/acme")).toBe(false);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("leaves ctx unchanged in org mode (does not invent a workspace slug)", () => {
    const eff = resolveSidebarCtx("/acme/members", orgCtx);
    expect(eff.workspaceSlug).toBeUndefined();
  });

  it("leaves ctx unchanged in account mode", () => {
    const eff = resolveSidebarCtx("/account/profile", orgCtx);
    expect(eff.workspaceSlug).toBeUndefined();
  });

  it("returns ctx untouched when workspaceSlug is already present", () => {
    const eff = resolveSidebarCtx("/acme/production/chat", wsCtx);
    expect(eff).toBe(wsCtx);
  });
});

// ---------------------------------------------------------------------------
// 6. activeHrefFor — most-specific (longest) match wins; segment-boundary safe.
// ---------------------------------------------------------------------------

describe("activeHrefFor", () => {
  it("returns the exact match when present", () => {
    expect(
      activeHrefFor("/acme/members", ["/acme/members", "/acme/billing"]),
    ).toBe("/acme/members");
  });

  it("prefers the longest (most specific) prefix match", () => {
    const hrefs = ["/acme/production/knowledge", "/acme/production/ask"];
    expect(activeHrefFor("/acme/production/knowledge/sources", hrefs)).toBe(
      "/acme/production/knowledge",
    );
  });

  it("does not let an ancestor root stay active on a sibling page", () => {
    // On /acme/members the org root "/acme" must NOT win over the deeper sibling.
    expect(activeHrefFor("/acme/members", ["/acme", "/acme/members"])).toBe(
      "/acme/members",
    );
    // …but the root IS active on the root page itself.
    expect(activeHrefFor("/acme", ["/acme", "/acme/members"])).toBe("/acme");
  });

  it("matches on path-segment boundary, not substring", () => {
    expect(activeHrefFor("/acme-2/x", ["/acme"])).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(activeHrefFor("/other", ["/acme", "/acme/members"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. ORG_SCOPE_ROUTES — config-derived iteration + resolveSidebarMode integration
// ---------------------------------------------------------------------------

describe("ORG_SCOPE_ROUTES", () => {
  it("every reserved route → resolveSidebarMode 'org' (derived from the set itself)", () => {
    const ctx: ScopeContext = { orgSlug: "acme" };
    for (const route of ORG_SCOPE_ROUTES) {
      const mode = resolveSidebarMode(`/acme/${route}`, ctx);
      expect(mode).toBe("org");
    }
  });

  it("a workspace-slug-shaped second segment → resolveSidebarMode 'workspace'", () => {
    const ctx: ScopeContext = { orgSlug: "acme" };
    // A slug that is NOT in ORG_SCOPE_ROUTES must resolve to workspace mode.
    const wsSlug = "my-workspace";
    expect(ORG_SCOPE_ROUTES.has(wsSlug)).toBe(false);
    expect(resolveSidebarMode(`/acme/${wsSlug}/ask`, ctx)).toBe("workspace");
  });

  it("contains at least one reserved route (guards against accidental empty set)", () => {
    expect(ORG_SCOPE_ROUTES.size).toBeGreaterThan(0);
  });

  it("every entry is a non-empty lowercase string with no slashes", () => {
    for (const route of ORG_SCOPE_ROUTES) {
      expect(route.length).toBeGreaterThan(0);
      expect(route).toBe(route.toLowerCase());
      expect(route).not.toContain("/");
    }
  });

  it("'members' is in the reserved set", () => {
    expect(ORG_SCOPE_ROUTES.has("members")).toBe(true);
  });

  it("'billing' is in the reserved set", () => {
    expect(ORG_SCOPE_ROUTES.has("billing")).toBe(true);
  });

  it("a workspace slug like 'production' is NOT in the reserved set", () => {
    expect(ORG_SCOPE_ROUTES.has("production")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. IA realignment — Automation/Activity removed entirely, no Workflows/Workbench
// ---------------------------------------------------------------------------

describe("IA realignment (spec §4/§5/§19)", () => {
  const ctx: Required<ScopeContext> = {
    orgSlug: "acme",
    workspaceSlug: "prod",
  };

  it("enumerateNavTargets has no Automation or Agents destination", () => {
    const targets = enumerateNavTargets(ctx);
    const hrefs = targets.map((t) => t.href);
    // The Automation feature area (and the old top-level /agents surface) is
    // gone entirely — no nav target should reference either.
    expect(hrefs).not.toContain("/acme/prod/automation/agents");
    expect(hrefs).not.toContain("/acme/prod/automation/agents/new");
    expect(hrefs).not.toContain("/acme/prod/agents");
    expect(hrefs).not.toContain("/acme/prod/agents/new");
  });

  it("enumerateNavTargets has no Activity destination", () => {
    const targets = enumerateNavTargets(ctx);
    const hrefs = targets.map((t) => t.href);
    expect(hrefs).not.toContain("/acme/prod/activity/runs");
    expect(targets.find((t) => t.label === "Activity")).toBeUndefined();
  });

  it("enumerateNavTargets has no Workflows destination and no bare Workbench root", () => {
    const targets = enumerateNavTargets(ctx);
    expect(targets.find((t) => t.label === "Workflows")).toBeUndefined();
    // Workbench pages are targets (Agents, Agent Tools, …) but the bare
    // /workbench root is a redirect, never a destination itself.
    expect(targets.find((t) => t.label === "Workbench")).toBeUndefined();
    expect(targets.map((t) => t.href)).not.toContain("/acme/prod/workflows");
    expect(targets.map((t) => t.href)).not.toContain("/acme/prod/workbench");
  });

  it("enumerateNavTargets surfaces the four first-class Workbench destinations", () => {
    const targets = enumerateNavTargets(ctx);
    const byLabel = (label: string) => targets.find((t) => t.label === label);
    expect(byLabel("Agents")?.href).toBe("/acme/prod/workbench/agents");
    expect(byLabel("Agent Tools")?.href).toBe("/acme/prod/workbench/tools");
    expect(byLabel("Environments")?.href).toBe(
      "/acme/prod/workbench/environments",
    );
    expect(byLabel("Sandboxes")?.href).toBe("/acme/prod/workbench/sandboxes");
    expect(byLabel("Agent Tools · MCP Servers")?.href).toBe(
      "/acme/prod/workbench/tools/mcp",
    );
    expect(byLabel("Settings · MCP Registries")?.href).toBe(
      "/acme/prod/settings/mcp-server-registries",
    );
  });

  it("all workspace hrefs are unique", () => {
    const eff = resolveSidebarCtx("/acme/prod/ask", ctx);
    const hrefs = getSidebarConfig("workspace").items.map((item) =>
      item.href(eff),
    );
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
