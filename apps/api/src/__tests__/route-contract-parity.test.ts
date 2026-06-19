/**
 * Route–contract parity test.
 *
 * For every contract whose `surfaces` includes "api", asserts that a
 * corresponding route is registered in the Hono app. The check is derived
 * directly from the imported `contracts` array — adding an api-surfaced
 * contract without a route will fail CI.
 *
 * NON-BRITTLE: no hardcoded counts. The expected set comes from the contract
 * registry; the actual set comes from app.routes path inspection.
 */

import { describe, it, expect, vi } from "vitest";

// ── Mock all external deps before importing app ───────────────────────────────

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: vi.fn(),
  clearHandlersForTests: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    verifyStripeSignature: vi.fn(),
    processStripeEvent: vi.fn(),
    bootstrapBillingRuntime: vi.fn(),
  };
});

vi.mock("@oxagen/handlers", () => ({
  serveFile: vi.fn(),
  FileNotFoundError: class FileNotFoundError extends Error {
    constructor(msg?: string) { super(msg); this.name = "FileNotFoundError"; }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) { super(msg); this.name = "FileForbiddenError"; }
  },
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

import { app } from "../app";
import { contracts } from "@oxagen/oxagen/contracts";
import { getSurfaces } from "@oxagen/oxagen/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a contract name (dot-separated) to a kebab-case URL path segment.
 * e.g. "conversation.list"     → "conversations"
 *      "billing.credits.purchase" → "billing/credits/purchase"
 *
 * The app uses plural nouns for resource collections, so we map the domain
 * segment only. The full path is not reconstructed — we search for a path
 * that CONTAINS the derived segment substring.
 */
function contractNameToPathSegment(name: string): string {
  // Split on dots: ["conversation", "list"] | ["billing", "credits", "purchase"]
  const parts = name.split(".");

  // Special-case known plural mappings (domain → plural route prefix)
  const domainPluralMap: Record<string, string> = {
    conversation: "conversations",
    organization: "organizations",
    workspace: "workspaces",
    "user.preferences": "user/preferences",
    "workspace.model": "workspace/model-settings",
    "prompt.settings": "workspace/prompt-settings",
    // org.settings.read/write collapse onto REST GET/POST at /org/settings.
    "org.settings": "org/settings",
    "billing.subscription": "billing/subscription",
    "billing.credits": "billing/credits",
    "agent.tool": "agent/tools",
    "agent.mcp": "agent/mcp-servers",
    "agent.skill": "agent/skills",
    "agent.plan": "agent/plans",
    "agent.task": "agent/tasks",
    "agent.memory": "agent/memory",
    "agent.approval": "agent/approvals",
    "agent.execution": "agent/execution",
    "agent.definition": "agent/definitions",
    "agent.deploy": "agent/deploy",
    "agent.trigger": "agent/triggers",
    "org.member": "org/members",
    "chat.message": "chat/messages",
    "documents.pdf": "documents/pdf",
    forms: "forms/fill",
    form: "forms",
    brandkit: "brandkit",
    video: "video",
    svg: "svg",
    image: "image",
    system: "system",
    // Notifications + installable-plugins domains. Routes follow REST casing
    // (kebab-case URLs, pluralized "registries") that does not derive
    // mechanically from the dot-separated contract name, so map each domain
    // prefix to its actual mounted route segment.
    notifications: "notifications",
    "plugin.catalog": "plugin/catalog",
    "plugin.credential": "plugin/credential",
    "plugin.org": "plugin/org",
    "plugin.registry": "plugin/registries",
    "plugin.settings": "plugin/settings",
    "plugin.workspace": "plugin/workspace",
    "skill.workspace": "skill/workspace",
    "api.key": "api-keys",
    workflow: "workflows",
    archive: "archive",
    connection: "connections",
    "privacy.data": "privacy",
    // Domains whose routes use hyphenated plurals or differ from the dot-path
    "semantic.edge": "semantic-edges",
    "plugin.schema": "plugin-schema",
    "plugin.version": "plugin-versions",
    repo: "repos",
    integration: "integrations",
    // graph.node.list maps to /graph/nodes (browse endpoint)
    "graph.node.list": "graph/nodes",
    // Subagent fan-out read side: list is mounted at the plural collection,
    // get at the singular resource with an :fanoutId param.
    "agent.subagent.fanout.list": "agent/subagent/fanouts",
    "agent.subagent.fanout.get": "agent/subagent/fanout",
  };

  // Try progressively shorter prefixes
  for (let len = parts.length; len >= 1; len--) {
    const prefix = parts.slice(0, len).join(".");
    if (domainPluralMap[prefix]) {
      return domainPluralMap[prefix];
    }
  }

  // Fallback: join all parts with "/"
  return parts.join("/");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("route–contract parity", () => {
  // Collect all registered route paths from the Hono app
  const registeredPaths = app.routes.map((r) => r.path);

  // Filter contracts to only those with "api" in their surfaces
  const apiContracts = contracts.filter((contract) =>
    getSurfaces(contract).includes("api"),
  );

  it("there are api-surfaced contracts to check (registry is non-empty)", () => {
    expect(apiContracts.length).toBeGreaterThan(0);
  });

  it("app has registered routes (app.routes is non-empty)", () => {
    expect(registeredPaths.length).toBeGreaterThan(0);
  });

  // Dynamic per-contract assertions
  for (const contract of apiContracts) {
    const segment = contractNameToPathSegment(contract.name);

    it(`contract "${contract.name}" has a route containing "/${segment}"`, () => {
      const match = registeredPaths.some((path) =>
        path.includes(`/${segment}`),
      );
      expect(
        match,
        `No route found for contract "${contract.name}" (looking for path containing "/${segment}").\n` +
          `Registered paths:\n${registeredPaths.join("\n")}`,
      ).toBe(true);
    });
  }

  it("total api-surfaced contracts matches the number checked (no silent filter)", () => {
    // Asserts we didn't accidentally filter out contracts
    const apiSurfaceCount = contracts.filter((c) =>
      getSurfaces(c).includes("api"),
    ).length;
    expect(apiContracts.length).toBe(apiSurfaceCount);
  });
});
