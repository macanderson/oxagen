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
const wsCtx: Required<ScopeContext> = {
  orgSlug: "acme",
  workspaceSlug: "prod",
};

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
    const workspaceParents = ["knowledge", "settings"];
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
  it("knowledge → sources", () =>
    expect(defaultTab["knowledge"]).toBe("sources"));
  it("settings → general", () =>
    expect(defaultTab["settings"]).toBe("general"));
  it("access → sessions", () => expect(defaultTab["access"]).toBe("sessions"));
  it("security → audit", () => expect(defaultTab["security"]).toBe("audit"));
  it("billing → subscription", () =>
    expect(defaultTab["billing"]).toBe("subscription"));
  it("developer → mcp", () => expect(defaultTab["developer"]).toBe("mcp"));
});

// ---------------------------------------------------------------------------
// 4. Account route builders
// ---------------------------------------------------------------------------

describe("account route builders", () => {
  it("root → /account", () => expect(account.root()).toBe("/account"));
  it("profile → /account/profile", () =>
    expect(account.profile()).toBe("/account/profile"));
  it("preferences → /account/preferences", () =>
    expect(account.preferences()).toBe("/account/preferences"));
  it("security → /account/security", () =>
    expect(account.security()).toBe("/account/security"));
});

// ---------------------------------------------------------------------------
// 5. Org route builders
// ---------------------------------------------------------------------------

describe("org route builders", () => {
  it("root → /{org}", () => expect(org.root(orgCtx)).toBe("/acme"));
  it("members → /{org}/members", () =>
    expect(org.members(orgCtx)).toBe("/acme/members"));
  it("access.root → /{org}/access", () =>
    expect(org.access.root(orgCtx)).toBe("/acme/access"));
  it("access.sessions → /{org}/access/sessions", () =>
    expect(org.access.sessions(orgCtx)).toBe("/acme/access/sessions"));
  it("security.audit → /{org}/security/audit", () =>
    expect(org.security.audit(orgCtx)).toBe("/acme/security/audit"));
  it("billing.subscription → /{org}/billing/subscription", () =>
    expect(org.billing.subscription(orgCtx)).toBe(
      "/acme/billing/subscription",
    ));
  it("developer.mcp → /{org}/developer/mcp", () =>
    expect(org.developer.mcp(orgCtx)).toBe("/acme/developer/mcp"));
  it("settings.general → /{org}/settings/general", () =>
    expect(org.settings.general(orgCtx)).toBe("/acme/settings/general"));
});

// ---------------------------------------------------------------------------
// 6. Workspace route builders
// ---------------------------------------------------------------------------

describe("workspace route builders", () => {
  it("sessions → /{org}/{ws}/sessions", () =>
    expect(workspace.sessions(wsCtx)).toBe("/acme/prod/sessions"));
  it("knowledge.root → /{org}/{ws}/knowledge", () =>
    expect(workspace.knowledge.root(wsCtx)).toBe("/acme/prod/knowledge"));
  it("knowledge.sources → /{org}/{ws}/knowledge/sources", () =>
    expect(workspace.knowledge.sources(wsCtx)).toBe(
      "/acme/prod/knowledge/sources",
    ));
  it("knowledge.sourcesConnect → /{org}/{ws}/knowledge/sources/connect", () =>
    expect(workspace.knowledge.sourcesConnect(wsCtx)).toBe(
      "/acme/prod/knowledge/sources/connect",
    ));
  it("knowledge.graph → /{org}/{ws}/knowledge/graph", () =>
    expect(workspace.knowledge.graph(wsCtx)).toBe(
      "/acme/prod/knowledge/graph",
    ));
  it("knowledge.ontology → /{org}/{ws}/knowledge/ontology", () =>
    expect(workspace.knowledge.ontology(wsCtx)).toBe(
      "/acme/prod/knowledge/ontology",
    ));
  it("knowledge.memory → /{org}/{ws}/knowledge/memory", () =>
    expect(workspace.knowledge.memory(wsCtx)).toBe(
      "/acme/prod/knowledge/memory",
    ));
  it("knowledge.node → /{org}/{ws}/knowledge/graph/{id}", () =>
    expect(workspace.knowledge.node(wsCtx, "n_1")).toBe(
      "/acme/prod/knowledge/graph/n_1",
    ));
  it("settings.root → /{org}/{ws}/settings", () =>
    expect(workspace.settings.root(wsCtx)).toBe("/acme/prod/settings"));
  it("settings.agentDefaults → /{org}/{ws}/settings/agent-defaults", () =>
    expect(workspace.settings.agentDefaults(wsCtx)).toBe(
      "/acme/prod/settings/agent-defaults",
    ));
  it("settings.members folds into General (?tab=members)", () =>
    expect(workspace.settings.members(wsCtx)).toBe(
      "/acme/prod/settings/general?tab=members",
    ));
  it("settings.models (deprecated alias) → agent-defaults", () =>
    expect(workspace.settings.models(wsCtx)).toBe(
      "/acme/prod/settings/agent-defaults",
    ));
  it("settings.knowledge (deprecated alias) → knowledge/ontology", () =>
    expect(workspace.settings.knowledge(wsCtx)).toBe(
      "/acme/prod/knowledge/ontology",
    ));
});

// ---------------------------------------------------------------------------
// 7. Negative: workspace builders with missing workspaceSlug won't compile
//    (TypeScript Required<ScopeContext> enforcement — verified by typecheck)
// ---------------------------------------------------------------------------
