/**
 * capability.registry.list handler tests.
 *
 * The handler reads the live in-process registry, so the test registers a few
 * synthetic contracts through the real registerCapability() and asserts
 * filtering, sorting, pagination, and the summary projection (including the
 * plugin entitlement enrichment, which is mocked at the pluginForContract seam).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  pluginForContract: vi.fn(),
}));

vi.mock("@oxagen/oxagen", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen")>();
  return { ...real, pluginForContract: mocks.pluginForContract };
});

import { registerCapability, clearRegistryForTests } from "@oxagen/oxagen";
import {
  capabilityRegistryListHandler,
  projectCapabilitySummary,
} from "./capability.registry.list";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function registerFixture(
  name: string,
  overrides: Partial<Parameters<typeof registerCapability>[0]> = {},
) {
  return registerCapability({
    name,
    domain: "testdom",
    description: `${name} description`,
    mode: "sync",
    surfaces: ["api", "mcp"],
    layers: ["api", "mcp", "unit", "docs"],
    scoped: true,
    sensitivity: "low",
    defaultEffect: "deny",
    defaultRoles: { org: { Owner: "allow" }, workspace: {} },
    input: z.object({}),
    output: z.object({}),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pluginForContract.mockReturnValue(undefined);
  clearRegistryForTests();
});

describe("capabilityRegistryListHandler", () => {
  it("lists registered capabilities sorted by name with domains", async () => {
    registerFixture("zeta_cap");
    registerFixture("alpha_cap");
    registerFixture("beta_cap", { domain: "otherdom" });

    const out = await capabilityRegistryListHandler(
      { limit: 500, offset: 0 },
      CTX,
    );

    expect(out.capabilities.map((c) => c.name)).toEqual([
      "alpha_cap",
      "beta_cap",
      "zeta_cap",
    ]);
    expect(out.total).toBe(3);
    expect(out.hasMore).toBe(false);
    expect(out.domains).toEqual(["otherdom", "testdom"]);
  });

  it("filters by domain, surface, sensitivity, and q substring", async () => {
    registerFixture("audit_read", { domain: "audit", sensitivity: "high" });
    registerFixture("billing_read", { domain: "billing", surfaces: ["api"] });
    registerFixture("agent_run", {
      domain: "agent",
      description: "runs an agent loop",
    });

    const byDomain = await capabilityRegistryListHandler(
      { domain: "audit", limit: 500, offset: 0 },
      CTX,
    );
    expect(byDomain.capabilities.map((c) => c.name)).toEqual(["audit_read"]);
    // domains list stays unfiltered so filter chips don't self-destruct.
    expect(byDomain.domains).toEqual(["agent", "audit", "billing"]);

    const bySurface = await capabilityRegistryListHandler(
      { surface: "mcp", limit: 500, offset: 0 },
      CTX,
    );
    expect(bySurface.capabilities.map((c) => c.name)).toEqual([
      "agent_run",
      "audit_read",
    ]);

    const bySensitivity = await capabilityRegistryListHandler(
      { sensitivity: "high", limit: 500, offset: 0 },
      CTX,
    );
    expect(bySensitivity.capabilities.map((c) => c.name)).toEqual([
      "audit_read",
    ]);

    const byQ = await capabilityRegistryListHandler(
      { q: "AGENT LOOP", limit: 500, offset: 0 },
      CTX,
    );
    expect(byQ.capabilities.map((c) => c.name)).toEqual(["agent_run"]);
  });

  it("filters by missingLayer (surface-gap view)", async () => {
    registerFixture("with_app", { layers: ["api", "mcp", "app"] });
    registerFixture("without_app", { layers: ["api", "mcp"] });

    const out = await capabilityRegistryListHandler(
      { missingLayer: "app", limit: 500, offset: 0 },
      CTX,
    );
    expect(out.capabilities.map((c) => c.name)).toEqual(["without_app"]);
  });

  it("paginates with hasMore", async () => {
    registerFixture("cap_a");
    registerFixture("cap_b");
    registerFixture("cap_c");

    const page = await capabilityRegistryListHandler(
      { limit: 2, offset: 0 },
      CTX,
    );
    expect(page.capabilities.map((c) => c.name)).toEqual(["cap_a", "cap_b"]);
    expect(page.hasMore).toBe(true);

    const last = await capabilityRegistryListHandler(
      { limit: 2, offset: 2 },
      CTX,
    );
    expect(last.capabilities.map((c) => c.name)).toEqual(["cap_c"]);
    expect(last.hasMore).toBe(false);
  });

  it("projects the plugin entitlement gate when a pack claims the capability", async () => {
    const cap = registerFixture("packed_cap");
    mocks.pluginForContract.mockReturnValue({
      id: "oxagen/media-svg",
      tier: "premium",
      minPlanTier: "build",
    });

    const summary = projectCapabilitySummary(cap);
    expect(summary.plugin).toEqual({
      id: "oxagen/media-svg",
      tier: "premium",
      minPlanTier: "build",
    });
  });

  it("projects defaults for optional descriptor fields", async () => {
    const cap = registerFixture("bare_cap", {
      agent: { requiresApproval: true, riskLevel: "medium" },
      audit: { targetKind: "graph.node", targetIdField: "nodeId" },
    });
    const summary = projectCapabilitySummary(cap);
    expect(summary.scoped).toBe(true);
    expect(summary.noBillingGate).toBe(false);
    expect(summary.agent).toEqual({
      requiresApproval: true,
      riskLevel: "medium",
      category: null,
    });
    expect(summary.auditTargetKind).toBe("graph.node");
    expect(summary.plugin).toBeNull();
  });
});
