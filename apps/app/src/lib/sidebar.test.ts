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
    expect(resolveSidebarMode("/account/profile", wsCtx)).toBe("account" satisfies SidebarMode);
    expect(resolveSidebarMode("/account/security", orgCtx)).toBe("account");
    expect(resolveSidebarMode("/account", wsCtx)).toBe("account");
  });

  it("returns 'workspace' when workspaceSlug is present and path is not /account", () => {
    expect(resolveSidebarMode("/acme/production/ask", wsCtx)).toBe("workspace");
    expect(resolveSidebarMode("/acme/production/knowledge/sources", wsCtx)).toBe("workspace");
  });

  it("returns 'workspace' from pathname when ctx has no workspaceSlug (org-layout boundary)", () => {
    // The AppShell at the org layout level has no workspaceSlug in ctx.
    // resolveSidebarMode must derive workspace mode purely from the URL.
    expect(resolveSidebarMode("/acme/production/ask", orgCtx)).toBe("workspace");
    expect(resolveSidebarMode("/acme/production/settings/general", orgCtx)).toBe("workspace");
    expect(resolveSidebarMode("/acme/my-ws/knowledge", orgCtx)).toBe("workspace");
  });

  it("returns 'org' for reserved org-scope routes even without workspaceSlug", () => {
    expect(resolveSidebarMode("/acme/members", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/access", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/security", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/billing", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/developer", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/settings", orgCtx)).toBe("org");
  });

  it("returns 'org' when no workspaceSlug and path is not /account", () => {
    expect(resolveSidebarMode("/acme", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/members", orgCtx)).toBe("org");
    expect(resolveSidebarMode("/acme/billing/subscription", orgCtx)).toBe("org");
  });

  it("account mode takes priority over workspace ctx", () => {
    // Even if workspaceSlug is present, /account prefix wins.
    expect(resolveSidebarMode("/account/security", wsCtx)).toBe("account");
  });
});

// ---------------------------------------------------------------------------
// 2. getSidebarConfig — item counts per mode
//
// Spec (application-shell spec §4):
//   workspace: 9 items (Ask, Knowledge, Agents, Automation, Activity, Studio, Marketplace, Workflows, Settings)
//   org:       6 items (Workspaces, Members, Access, Security, Billing, Developer)
//   account:   4 items (Back to app, Profile, Preferences, Security)
// ---------------------------------------------------------------------------

describe("getSidebarConfig item counts", () => {
  it("workspace config has exactly 10 items", () => {
    const config = getSidebarConfig("workspace");
    expect(config.mode).toBe("workspace");
    expect(config.items).toHaveLength(10);
  });

  it("org config has exactly 7 items", () => {
    const config = getSidebarConfig("org");
    expect(config.mode).toBe("org");
    expect(config.items).toHaveLength(7);
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

  it("workspace config has exactly three 'tools' group items (Studio, Marketplace, Workflows)", () => {
    const items = getSidebarConfig("workspace").items;
    const toolsItems = items.filter((item) => item.group === "tools");
    expect(toolsItems).toHaveLength(3);
    const ids = toolsItems.map((i) => i.id);
    expect(ids).toContain("studio");
    expect(ids).toContain("marketplace");
    expect(ids).toContain("workflows");
  });

  it("workspace config has exactly one 'footer' group item (Settings)", () => {
    const items = getSidebarConfig("workspace").items;
    const footerItems = items.filter((item) => item.group === "footer");
    expect(footerItems).toHaveLength(1);
    expect(footerItems[0]?.id).toBe("settings");
  });

  it("org config 'workspaces' item has external: true", () => {
    const items = getSidebarConfig("org").items;
    const workspacesItem = items.find((item) => item.id === "workspaces");
    expect(workspacesItem?.external).toBe(true);
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

    it("ask -> /{org}/{ws}/ask", () => {
      expect(findItem("ask").href(wsCtx)).toBe("/acme/production/ask");
    });

    it("knowledge -> /{org}/{ws}/knowledge", () => {
      expect(findItem("knowledge").href(wsCtx)).toBe("/acme/production/knowledge");
    });

    it("agents -> /{org}/{ws}/agents", () => {
      expect(findItem("agents").href(wsCtx)).toBe("/acme/production/agents");
    });

    it("automation -> /{org}/{ws}/automation", () => {
      expect(findItem("automation").href(wsCtx)).toBe("/acme/production/automation");
    });

    it("agent-runs -> /{org}/{ws}/agents/runs", () => {
      expect(findItem("agent-runs").href(wsCtx)).toBe("/acme/production/agents/runs");
    });

    it("activity -> /{org}/{ws}/activity", () => {
      expect(findItem("activity").href(wsCtx)).toBe("/acme/production/activity");
    });

    it("studio -> /{org}/{ws}/studio", () => {
      expect(findItem("studio").href(wsCtx)).toBe("/acme/production/studio");
    });

    it("marketplace -> /{org}/settings/plugins (org-level, from ws ctx)", () => {
      expect(findItem("marketplace").href(wsCtx)).toBe("/acme/settings/plugins");
    });

    it("settings -> /{org}/{ws}/settings", () => {
      expect(findItem("settings").href(wsCtx)).toBe("/acme/production/settings");
    });
  });

  describe("org mode", () => {
    const config = getSidebarConfig("org");
    const findItem = (id: string) => config.items.find((i) => i.id === id)!;

    it("workspaces -> /{org}", () => {
      expect(findItem("workspaces").href(orgCtx)).toBe("/acme");
    });

    it("members -> /{org}/members", () => {
      expect(findItem("members").href(orgCtx)).toBe("/acme/members");
    });

    it("access -> /{org}/access", () => {
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
      expect(findItem("org-settings").href(orgCtx)).toBe("/acme/settings/general");
    });
  });

  describe("account mode", () => {
    const config = getSidebarConfig("account");
    const findItem = (id: string) => config.items.find((i) => i.id === id)!;

    it("back with workspaceSlug -> /{org}/{ws}/ask", () => {
      expect(findItem("back").href(wsCtx)).toBe("/acme/production/ask");
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
    expect(hrefs).toContain("/acme/production/ask");
    expect(hrefs).toContain("/acme/production/knowledge/sources");
    expect(hrefs).toContain("/acme/production/automation/triggers");
    expect(hrefs).toContain("/acme/production/studio");
  });

  it("includes org paths regardless of workspaceSlug", () => {
    const targetsWithWs = enumerateNavTargets(wsCtx);
    const targetsOrgOnly = enumerateNavTargets(orgCtx);

    for (const targets of [targetsWithWs, targetsOrgOnly]) {
      const hrefs = targets.map((t) => t.href);
      expect(hrefs).toContain("/acme/access");
      expect(hrefs).toContain("/acme/access/grants");
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

    expect(hrefs).not.toContain("/acme/production/ask");
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
    const hrefs = getSidebarConfig("workspace").items.map((item) => item.href(eff));
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
    expect(activeHrefFor("/acme/members", ["/acme/members", "/acme/billing"])).toBe("/acme/members");
  });

  it("prefers the longest (most specific) prefix match", () => {
    const hrefs = ["/acme/production/knowledge", "/acme/production/ask"];
    expect(activeHrefFor("/acme/production/knowledge/sources", hrefs)).toBe("/acme/production/knowledge");
  });

  it("does not let an ancestor root stay active on a sibling page", () => {
    // On /acme/members the org root "/acme" must NOT win over the deeper sibling.
    expect(activeHrefFor("/acme/members", ["/acme", "/acme/members"])).toBe("/acme/members");
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
// 8. Workflows sidebar item — added in Phase 2
// ---------------------------------------------------------------------------

describe("Workflows sidebar item", () => {
  it("'workflows' item exists in workspace config tools group", () => {
    const items = getSidebarConfig("workspace").items;
    const workflows = items.find((item) => item.id === "workflows");
    expect(workflows).toBeDefined();
    expect(workflows?.group).toBe("tools");
    expect(workflows?.label).toBe("Workflows");
  });

  it("'workflows' href resolves to /{org}/{ws}/workflows", () => {
    const ctx: Required<ScopeContext> = { orgSlug: "acme", workspaceSlug: "prod" };
    const items = getSidebarConfig("workspace").items;
    const workflows = items.find((item) => item.id === "workflows");
    expect(workflows?.href(ctx)).toBe("/acme/prod/workflows");
  });

  it("'workflows' href falls back to org root when workspaceSlug absent", () => {
    const ctx: ScopeContext = { orgSlug: "acme" };
    const items = getSidebarConfig("workspace").items;
    const workflows = items.find((item) => item.id === "workflows");
    expect(workflows?.href(ctx)).toBe("/acme");
  });

  it("enumerateNavTargets includes Workflows for workspace context", () => {
    const ctx: Required<ScopeContext> = { orgSlug: "acme", workspaceSlug: "prod" };
    const targets = enumerateNavTargets(ctx);
    const workflowsTarget = targets.find((t) => t.label === "Workflows");
    expect(workflowsTarget).toBeDefined();
    expect(workflowsTarget?.href).toBe("/acme/prod/workflows");
    expect(workflowsTarget?.parent).toBe("workflows");
  });

  it("all workspace hrefs are unique (including Workflows)", () => {
    const ctx: Required<ScopeContext> = { orgSlug: "acme", workspaceSlug: "prod" };
    const eff = resolveSidebarCtx("/acme/prod/ask", ctx);
    const hrefs = getSidebarConfig("workspace").items.map((item) => item.href(eff));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
