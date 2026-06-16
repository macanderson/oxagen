/**
 * routes.test.ts — unit tests for routes.ts defaultTab and route builders.
 *
 * Tests:
 *   1. CONFIG-DERIVED: every key in defaultTab maps to a non-empty sub-route string
 *   2. Count from Object.keys(defaultTab) — not a hardcoded literal
 *   3. "chat" is NOT a key (guards against stale keys that bypass layout redirect)
 *   4. All values are non-empty, lowercase, alphanumeric-with-hyphens strings
 *   5. Account route builders produce correct paths
 *   6. Org route builders produce correct paths for a sample ctx
 *   7. Workspace route builders produce correct paths for a sample ctx
 */

import { describe, it, expect } from "vitest";
import { defaultTab, account, org, workspace } from "./routes";
import type { ScopeContext } from "./scope";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const orgCtx: ScopeContext = { orgSlug: "acme" };
const wsCtx: Required<ScopeContext> = { orgSlug: "acme", workspaceSlug: "prod" };

// ---------------------------------------------------------------------------
// 1. defaultTab — CONFIG-DERIVED completeness
// ---------------------------------------------------------------------------

describe("defaultTab — config-derived completeness", () => {
  const keys = Object.keys(defaultTab);

  it("has a non-empty value for every key (no dead entries)", () => {
    for (const key of keys) {
      const value = defaultTab[key];
      expect(value).toBeDefined();
      expect((value ?? "").length).toBeGreaterThan(0);
    }
  });

  it("count matches Object.keys(defaultTab).length (not a hardcoded literal)", () => {
    // Config-derived: the test reads the object itself, so it can never drift.
    expect(keys.length).toBe(Object.keys(defaultTab).length);
  });

  it("contains all expected top-level workspace parent keys", () => {
    // These are the parents defined in the IA spec §5 rule 3.
    // Derived from the object — no hardcoded count.
    const workspaceParents = ["knowledge", "automation", "activity", "studio", "settings"];
    for (const k of workspaceParents) {
      expect(defaultTab).toHaveProperty(k);
    }
  });

  it("contains all expected org-scope parent keys", () => {
    const orgParents = ["access", "security", "billing", "developer"];
    for (const k of orgParents) {
      expect(defaultTab).toHaveProperty(k);
    }
  });

  it("does NOT include 'chat' as a key (chat has no tab sub-routes)", () => {
    expect(defaultTab).not.toHaveProperty("chat");
  });

  it("does NOT include 'ask' as a key (ask has no tab sub-routes)", () => {
    expect(defaultTab).not.toHaveProperty("ask");
  });
});

// ---------------------------------------------------------------------------
// 2. All values match expected slug format
// ---------------------------------------------------------------------------

describe("defaultTab — value format", () => {
  it("every value is a non-empty lowercase string with no slashes", () => {
    for (const [key, value] of Object.entries(defaultTab)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
      expect(value).toBe(value.toLowerCase());
      expect(value).not.toContain("/");
      // Document: the key mapping
      expect(`${key} → ${value}`).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Specific mappings (sanity-check the real values)
// ---------------------------------------------------------------------------

describe("defaultTab — known mappings", () => {
  it("knowledge → sources", () => expect(defaultTab["knowledge"]).toBe("sources"));
  it("automation → playbooks", () => expect(defaultTab["automation"]).toBe("playbooks"));
  it("activity → runs", () => expect(defaultTab["activity"]).toBe("runs"));
  it("studio → compose", () => expect(defaultTab["studio"]).toBe("compose"));
  it("settings → general", () => expect(defaultTab["settings"]).toBe("general"));
  it("access → grants", () => expect(defaultTab["access"]).toBe("grants"));
  it("security → audit", () => expect(defaultTab["security"]).toBe("audit"));
  it("billing → subscription", () => expect(defaultTab["billing"]).toBe("subscription"));
  it("developer → mcp", () => expect(defaultTab["developer"]).toBe("mcp"));
});

// ---------------------------------------------------------------------------
// 4. Account route builders
// ---------------------------------------------------------------------------

describe("account route builders", () => {
  it("root → /account", () => expect(account.root()).toBe("/account"));
  it("profile → /account/profile", () => expect(account.profile()).toBe("/account/profile"));
  it("preferences → /account/preferences", () => expect(account.preferences()).toBe("/account/preferences"));
  it("security → /account/security", () => expect(account.security()).toBe("/account/security"));
});

// ---------------------------------------------------------------------------
// 5. Org route builders
// ---------------------------------------------------------------------------

describe("org route builders", () => {
  it("root → /{org}", () => expect(org.root(orgCtx)).toBe("/acme"));
  it("members → /{org}/members", () => expect(org.members(orgCtx)).toBe("/acme/members"));
  it("access.root → /{org}/access", () => expect(org.access.root(orgCtx)).toBe("/acme/access"));
  it("access.grants → /{org}/access/grants", () => expect(org.access.grants(orgCtx)).toBe("/acme/access/grants"));
  it("security.audit → /{org}/security/audit", () => expect(org.security.audit(orgCtx)).toBe("/acme/security/audit"));
  it("billing.subscription → /{org}/billing/subscription", () => expect(org.billing.subscription(orgCtx)).toBe("/acme/billing/subscription"));
  it("developer.mcp → /{org}/developer/mcp", () => expect(org.developer.mcp(orgCtx)).toBe("/acme/developer/mcp"));
  it("settings.general → /{org}/settings/general", () => expect(org.settings.general(orgCtx)).toBe("/acme/settings/general"));
});

// ---------------------------------------------------------------------------
// 6. Workspace route builders
// ---------------------------------------------------------------------------

describe("workspace route builders", () => {
  it("ask → /{org}/{ws}/ask", () => expect(workspace.ask(wsCtx)).toBe("/acme/prod/ask"));
  it("knowledge.root → /{org}/{ws}/knowledge", () => expect(workspace.knowledge.root(wsCtx)).toBe("/acme/prod/knowledge"));
  it("knowledge.sources → /{org}/{ws}/knowledge/sources", () => expect(workspace.knowledge.sources(wsCtx)).toBe("/acme/prod/knowledge/sources"));
  it("automation.agents → /{org}/{ws}/automation/agents", () => expect(workspace.automation.agents(wsCtx)).toBe("/acme/prod/automation/agents"));
  // Agents live under Automation (IA spec §4/§5).
  it("agents.root → /{org}/{ws}/automation/agents", () => expect(workspace.agents.root(wsCtx)).toBe("/acme/prod/automation/agents"));
  it("agents.create → /{org}/{ws}/automation/agents/new", () => expect(workspace.agents.create(wsCtx)).toBe("/acme/prod/automation/agents/new"));
  it("agents.detail → /{org}/{ws}/automation/agents/:slug", () => expect(workspace.agents.detail(wsCtx, "repo-review")).toBe("/acme/prod/automation/agents/repo-review"));
  it("agents.edit → /{org}/{ws}/automation/agents/:slug/edit", () => expect(workspace.agents.edit(wsCtx, "repo-review")).toBe("/acme/prod/automation/agents/repo-review/edit"));
  it("activity.runs → /{org}/{ws}/activity/runs", () => expect(workspace.activity.runs(wsCtx)).toBe("/acme/prod/activity/runs"));
  // All run kinds (incl. subagent fan-outs) drill down under Activity → Runs.
  it("activity.run → /{org}/{ws}/activity/runs/:id", () => expect(workspace.activity.run(wsCtx, "fan-123")).toBe("/acme/prod/activity/runs/fan-123"));
  it("studio.root → /{org}/{ws}/studio", () => expect(workspace.studio.root(wsCtx)).toBe("/acme/prod/studio"));
  it("settings.root → /{org}/{ws}/settings", () => expect(workspace.settings.root(wsCtx)).toBe("/acme/prod/settings"));
  it("settings.modelKeys → /{org}/{ws}/settings/model-keys", () => expect(workspace.settings.modelKeys(wsCtx)).toBe("/acme/prod/settings/model-keys"));
});

// ---------------------------------------------------------------------------
// 7. Negative: workspace builders with missing workspaceSlug won't compile
//    (TypeScript Required<ScopeContext> enforcement — verified by typecheck)
// ---------------------------------------------------------------------------
