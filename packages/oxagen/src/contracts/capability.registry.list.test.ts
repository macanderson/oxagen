import { describe, expect, it } from "vitest";
import { capabilityRegistryList } from "./capability.registry.list";
import { getCapability } from "../registry";

describe("capability.registry.list capability", () => {
  it("is registered under its name with the capability domain", () => {
    const cap = getCapability("list_capability_registry");
    expect(cap).toBeDefined();
    expect(capabilityRegistryList.domain).toBe("capability");
    expect(capabilityRegistryList.mode).toBe("sync");
  });

  it("is read-only, deny-by-default, billing-gate-exempt, and governance-gated", () => {
    expect(capabilityRegistryList.scoped).toBe(true);
    expect(capabilityRegistryList.noBillingGate).toBe(true);
    expect(capabilityRegistryList.defaultEffect).toBe("deny");
    expect(capabilityRegistryList.sensitivity).toBe("low");
    expect(capabilityRegistryList.defaultRoles.org).toMatchObject({
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
    });
  });

  it("declares the app layer (UI parity promise) plus api/mcp/unit/docs", () => {
    expect(capabilityRegistryList.layers).toEqual(
      expect.arrayContaining(["api", "mcp", "unit", "docs", "app"]),
    );
  });

  it("defaults limit=500, offset=0 on empty input", () => {
    const parsed = capabilityRegistryList.input.parse({});
    expect(parsed.limit).toBe(500);
    expect(parsed.offset).toBe(0);
  });

  it("enforces limit bounds (1–1000)", () => {
    expect(() => capabilityRegistryList.input.parse({ limit: 0 })).toThrow();
    expect(() => capabilityRegistryList.input.parse({ limit: 1001 })).toThrow();
    expect(capabilityRegistryList.input.parse({ limit: 1000 }).limit).toBe(
      1000,
    );
  });

  it("rejects an unknown surface or missingLayer filter", () => {
    expect(() =>
      capabilityRegistryList.input.parse({ surface: "web" }),
    ).toThrow();
    expect(() =>
      capabilityRegistryList.input.parse({ missingLayer: "marketing" }),
    ).toThrow();
    expect(
      capabilityRegistryList.input.parse({ missingLayer: "app" }).missingLayer,
    ).toBe("app");
  });

  it("parses a valid output row", () => {
    const parsed = capabilityRegistryList.output.parse({
      capabilities: [
        {
          name: "query_audit_log",
          domain: "audit",
          description: "Query the audit spine",
          mode: "sync",
          surfaces: ["api", "mcp"],
          layers: ["api", "mcp", "unit", "docs"],
          sensitivity: "high",
          defaultEffect: "deny",
          scoped: true,
          noBillingGate: false,
          agent: {
            requiresApproval: false,
            riskLevel: "low",
            category: "read",
          },
          auditTargetKind: null,
          plugin: null,
          orgRoles: { Owner: "allow", Admin: "allow" },
          workspaceRoles: { Owner: "allow" },
        },
      ],
      total: 1,
      hasMore: false,
      limit: 500,
      offset: 0,
      domains: ["audit"],
    });
    expect(parsed.capabilities[0]?.name).toBe("query_audit_log");
  });

  it("rejects an output row with an invalid grant effect", () => {
    expect(() =>
      capabilityRegistryList.output.parse({
        capabilities: [
          {
            name: "x",
            domain: "x",
            description: "x",
            mode: "sync",
            surfaces: [],
            layers: [],
            sensitivity: "low",
            defaultEffect: "deny",
            scoped: true,
            noBillingGate: false,
            agent: null,
            auditTargetKind: null,
            plugin: null,
            orgRoles: { Owner: "maybe" },
            workspaceRoles: {},
          },
        ],
        total: 1,
        hasMore: false,
        limit: 500,
        offset: 0,
        domains: [],
      }),
    ).toThrow();
  });
});
