import { describe, expect, it } from "vitest";
import type { CapabilityRegistrySummary } from "@oxagen/oxagen/contracts/capability.registry.list";
import {
  filterCatalog,
  hasSurfaceGap,
  missingCoreLayers,
  allowedOrgRoles,
  EMPTY_FILTER,
} from "./catalog-filter";

function row(
  over: Partial<CapabilityRegistrySummary>,
): CapabilityRegistrySummary {
  return {
    name: "cap_x",
    domain: "test",
    description: "does x",
    mode: "sync",
    surfaces: ["api", "mcp"],
    layers: ["api", "mcp", "docs", "app"],
    sensitivity: "low",
    defaultEffect: "deny",
    scoped: true,
    noBillingGate: false,
    agent: null,
    auditTargetKind: null,
    plugin: null,
    orgRoles: { Owner: "allow", Admin: "allow", Compliance: "deny" },
    workspaceRoles: {},
    ...over,
  };
}

describe("hasSurfaceGap / missingCoreLayers", () => {
  it("is gap-free when all core layers are declared", () => {
    const full = row({
      layers: ["schema", "api", "mcp", "unit", "docs", "app"],
    });
    expect(hasSurfaceGap(full)).toBe(false);
    expect(missingCoreLayers(full)).toEqual([]);
  });

  it("reports each missing core layer", () => {
    const gappy = row({ layers: ["api", "unit"] });
    expect(hasSurfaceGap(gappy)).toBe(true);
    expect(missingCoreLayers(gappy)).toEqual(["mcp", "docs", "app"]);
  });
});

describe("allowedOrgRoles", () => {
  it("returns only allow-effect roles, sorted", () => {
    expect(allowedOrgRoles(row({}))).toEqual(["Admin", "Owner"]);
  });
});

describe("filterCatalog", () => {
  const rows = [
    row({
      name: "query_audit_log",
      domain: "audit",
      description: "query the spine",
    }),
    row({ name: "list_iam_roles", domain: "iam", layers: ["api", "mcp"] }),
    row({
      name: "get_usage_breakdown",
      domain: "billing",
      layers: ["api", "mcp", "docs"],
    }),
  ];

  it("passes everything through with the empty filter", () => {
    expect(filterCatalog(rows, EMPTY_FILTER)).toHaveLength(3);
  });

  it("filters by domain", () => {
    const out = filterCatalog(rows, { ...EMPTY_FILTER, domain: "iam" });
    expect(out.map((r) => r.name)).toEqual(["list_iam_roles"]);
  });

  it("filters by case-insensitive q across name/domain/description", () => {
    expect(
      filterCatalog(rows, { ...EMPTY_FILTER, q: "SPINE" }).map((r) => r.name),
    ).toEqual(["query_audit_log"]);
    expect(
      filterCatalog(rows, { ...EMPTY_FILTER, q: "billing" }).map((r) => r.name),
    ).toEqual(["get_usage_breakdown"]);
  });

  it("filters to surface gaps only", () => {
    const out = filterCatalog(rows, { ...EMPTY_FILTER, gapOnly: true });
    expect(out.map((r) => r.name)).toEqual([
      "list_iam_roles",
      "get_usage_breakdown",
    ]);
  });

  it("filters by missingLayer (hub deep link)", () => {
    const out = filterCatalog(rows, { ...EMPTY_FILTER, missingLayer: "docs" });
    expect(out.map((r) => r.name)).toEqual(["list_iam_roles"]);
  });

  it("combines filters", () => {
    const out = filterCatalog(rows, {
      q: "roles",
      domain: "iam",
      gapOnly: true,
      missingLayer: "app",
    });
    expect(out.map((r) => r.name)).toEqual(["list_iam_roles"]);
  });
});
