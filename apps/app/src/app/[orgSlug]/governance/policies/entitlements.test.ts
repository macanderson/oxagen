import { describe, expect, it } from "vitest";
import type { CapabilityRegistrySummary } from "@oxagen/oxagen/contracts/capability.registry.list";
import { deriveEntitlementRows } from "./entitlements";

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

describe("deriveEntitlementRows", () => {
  it("keeps only pack-gated capabilities, sorted by pack then capability", () => {
    const rows = [
      row({
        name: "zeta",
        plugin: { id: "oxagen/b-pack", tier: "free", minPlanTier: null },
      }),
      row({ name: "plain" }),
      row({
        name: "alpha",
        plugin: { id: "oxagen/b-pack", tier: "free", minPlanTier: null },
      }),
      row({
        name: "media",
        plugin: { id: "oxagen/a-pack", tier: "premium", minPlanTier: "build" },
      }),
    ];
    const out = deriveEntitlementRows(rows, "free");
    expect(out.map((r) => `${r.packId}:${r.capability}`)).toEqual([
      "oxagen/a-pack:media",
      "oxagen/b-pack:alpha",
      "oxagen/b-pack:zeta",
    ]);
  });

  it("marks the plan gate blocked when the org tier is below minPlanTier", () => {
    const rows = [
      row({
        name: "media",
        plugin: { id: "p", tier: "premium", minPlanTier: "scale" },
      }),
    ];
    expect(deriveEntitlementRows(rows, "build")[0]?.planSatisfied).toBe(false);
    expect(deriveEntitlementRows(rows, "scale")[0]?.planSatisfied).toBe(true);
    expect(deriveEntitlementRows(rows, "enterprise")[0]?.planSatisfied).toBe(
      true,
    );
  });

  it("treats a pack without minPlanTier as satisfied on any plan", () => {
    const rows = [
      row({ name: "x", plugin: { id: "p", tier: "free", minPlanTier: null } }),
    ];
    expect(deriveEntitlementRows(rows, "free")[0]?.planSatisfied).toBe(true);
  });

  it("returns [] when nothing is pack-gated", () => {
    expect(deriveEntitlementRows([row({})], "enterprise")).toEqual([]);
  });
});
