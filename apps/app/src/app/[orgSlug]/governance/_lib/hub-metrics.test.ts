import { describe, expect, it } from "vitest";
import type { CapabilityRegistrySummary } from "@oxagen/oxagen/contracts/capability.registry.list";
import { computeChainMetrics, formatCappedCount } from "./hub-metrics";

function row(
  over: Partial<CapabilityRegistrySummary>,
): CapabilityRegistrySummary {
  return {
    name: "cap_x",
    domain: "test",
    description: "x",
    mode: "sync",
    surfaces: ["api", "mcp"],
    layers: ["api", "mcp"],
    sensitivity: "low",
    defaultEffect: "deny",
    scoped: true,
    noBillingGate: false,
    agent: null,
    auditTargetKind: null,
    plugin: null,
    orgRoles: {},
    workspaceRoles: {},
    ...over,
  };
}

describe("computeChainMetrics", () => {
  it("counts each accountability-chain dimension", () => {
    const rows = [
      row({
        name: "a",
        layers: ["api", "mcp", "app", "unit", "e2e"],
        scoped: true,
      }),
      row({
        name: "b",
        layers: ["api", "unit"],
        scoped: false,
        noBillingGate: true,
      }),
      row({
        name: "c",
        plugin: { id: "oxagen/pack", tier: "premium", minPlanTier: "build" },
        auditTargetKind: "widget",
      }),
    ];
    expect(computeChainMetrics(rows)).toEqual({
      totalContracts: 3,
      appCovered: 1,
      scoped: 2,
      billingGated: 2,
      entitlementGated: 1,
      e2eVerified: 1,
      unitVerified: 2,
      auditBound: 1,
    });
  });

  it("returns zeros for an empty registry", () => {
    expect(computeChainMetrics([]).totalContracts).toBe(0);
  });
});

describe("formatCappedCount", () => {
  it("shows the exact count when the page was not full", () => {
    expect(formatCappedCount(7, false)).toBe("7");
  });
  it("shows N+ when more rows exist beyond the sampled page", () => {
    expect(formatCappedCount(200, true)).toBe("200+");
  });
});
