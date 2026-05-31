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
  getSidebarConfig,
  enumerateNavTargets,
  type SidebarMode,
} from "./sidebar.js";
import type { ScopeContext } from "./scope.js";

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
    expect(resolveSidebarMode("/acme/production/chat", wsCtx)).toBe("workspace");
    expect(resolveSidebarMode("/acme/production/knowledge/sources", wsCtx)).toBe("workspace");
  });

  it("returns 'workspace' from pathname when ctx has no workspaceSlug (org-layout boundary)", () => {
    // The AppShell at the org layout level has no workspaceSlug in ctx.
    // resolveSidebarMode must derive workspace mode purely from the URL.
    expect(resolveSidebarMode("/acme/production/chat", orgCtx)).toBe("workspace");
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
    expect(resolveSidebarMode("/account/privacy", wsCtx)).toBe("account");
  });
});

// ---------------------------------------------------------------------------
// 2. getSidebarConfig — item counts per mode
//
// Spec (application-shell spec §4):
//   workspace: 6 items (Chat, Knowledge, Automation, Activity, Studio, Settings)
//   org:       6 items (Workspaces, Members, Access, Security, Billing, Developer)
//   account:   6 items (Back to app + Profile, Security, Cases, Notifications, Privacy)
// ---------------------------------------------------------------------------

describe("getSidebarConfig item counts", () => {
  it("workspace config has exactly 6 items", () => {
    const config = getSidebarConfig("workspace");
    expect(config.mode).toBe("workspace");
    expect(config.items).toHaveLength(6);
  });

  it("org config has exactly 6 items", () => {
    const config = getSidebarConfig("org");
    expect(config.mode).toBe("org");
    expect(config.items).toHaveLength(6);
  });

  it("account config has exactly 6 items (5 personal + 1 back link)", () => {
    const config = getSidebarConfig("account");
    expect(config.mode).toBe("account");
    expect(config.items).toHaveLength(6);
  });

  it("account config contains exactly one isReturn item", () => {
    const items = getSidebarConfig("account").items;
    const returnItems = items.filter((item) => item.isReturn === true);
    expect(returnItems).toHaveLength(1);
    expect(returnItems[0]?.id).toBe("back-to-app");
  });

  it("workspace config has exactly one 'tools' group item (Studio)", () => {
    const items = getSidebarConfig("workspace").items;
    const toolsItems = items.filter((item) => item.group === "tools");
    expect(toolsItems).toHaveLength(1);
    expect(toolsItems[0]?.id).toBe("studio");
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
});

// ---------------------------------------------------------------------------
// 3. href builders — concrete paths for sample ctx
// ---------------------------------------------------------------------------

describe("href builders produce correct paths", () => {
  describe("workspace mode", () => {
    const config = getSidebarConfig("workspace");
    const findItem = (id: string) => config.items.find((i) => i.id === id)!;

    it("chat -> /{org}/{ws}/chat", () => {
      expect(findItem("chat").href(wsCtx)).toBe("/acme/production/chat");
    });

    it("knowledge -> /{org}/{ws}/knowledge", () => {
      expect(findItem("knowledge").href(wsCtx)).toBe("/acme/production/knowledge");
    });

    it("automation -> /{org}/{ws}/automation", () => {
      expect(findItem("automation").href(wsCtx)).toBe("/acme/production/automation");
    });

    it("activity -> /{org}/{ws}/activity", () => {
      expect(findItem("activity").href(wsCtx)).toBe("/acme/production/activity");
    });

    it("studio -> /{org}/{ws}/tools/studio", () => {
      expect(findItem("studio").href(wsCtx)).toBe("/acme/production/tools/studio");
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
  });

  describe("account mode", () => {
    const config = getSidebarConfig("account");
    const findItem = (id: string) => config.items.find((i) => i.id === id)!;

    it("back-to-app with workspaceSlug -> /{org}/{ws}", () => {
      expect(findItem("back-to-app").href(wsCtx)).toBe("/acme/production");
    });

    it("back-to-app without workspaceSlug -> /{org}", () => {
      expect(findItem("back-to-app").href(orgCtx)).toBe("/acme");
    });

    it("profile -> /account/profile", () => {
      expect(findItem("profile").href(wsCtx)).toBe("/account/profile");
    });

    it("account-security -> /account/security", () => {
      expect(findItem("account-security").href(wsCtx)).toBe("/account/security");
    });

    it("cases -> /account/cases", () => {
      expect(findItem("cases").href(wsCtx)).toBe("/account/cases");
    });

    it("notifications -> /account/notifications", () => {
      expect(findItem("notifications").href(wsCtx)).toBe("/account/notifications");
    });

    it("privacy -> /account/privacy", () => {
      expect(findItem("privacy").href(wsCtx)).toBe("/account/privacy");
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
    expect(hrefs).toContain("/acme/production/chat");
    expect(hrefs).toContain("/acme/production/knowledge/sources");
    expect(hrefs).toContain("/acme/production/automation/triggers");
    expect(hrefs).toContain("/acme/production/tools/studio");
  });

  it("includes org paths regardless of workspaceSlug", () => {
    const targetsWithWs = enumerateNavTargets(wsCtx);
    const targetsOrgOnly = enumerateNavTargets(orgCtx);

    for (const targets of [targetsWithWs, targetsOrgOnly]) {
      const hrefs = targets.map((t) => t.href);
      expect(hrefs).toContain("/acme/access");
      expect(hrefs).toContain("/acme/access/grants");
      expect(hrefs).toContain("/acme/security/sso");
      expect(hrefs).toContain("/acme/billing/subscription");
      expect(hrefs).toContain("/acme/developer/mcp");
    }
  });

  it("includes account paths regardless of ctx", () => {
    const targets = enumerateNavTargets(orgCtx);
    const hrefs = targets.map((t) => t.href);

    expect(hrefs).toContain("/account/profile");
    expect(hrefs).toContain("/account/security");
    expect(hrefs).toContain("/account/cases");
    expect(hrefs).toContain("/account/notifications");
    expect(hrefs).toContain("/account/privacy");
  });

  it("does NOT include workspace paths when workspaceSlug is absent", () => {
    const targets = enumerateNavTargets(orgCtx);
    const hrefs = targets.map((t) => t.href);

    expect(hrefs).not.toContain("/acme/production/chat");
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
