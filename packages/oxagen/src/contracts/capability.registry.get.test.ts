import { describe, expect, it } from "vitest";
import { capabilityRegistryGet } from "./capability.registry.get";
import { getCapability } from "../registry";

describe("capability.registry.get capability", () => {
  it("is registered under its name with the capability domain", () => {
    const cap = getCapability("get_capability_registry");
    expect(cap).toBeDefined();
    expect(capabilityRegistryGet.domain).toBe("capability");
    expect(capabilityRegistryGet.mode).toBe("sync");
  });

  it("is read-only, deny-by-default, billing-gate-exempt, and governance-gated", () => {
    expect(capabilityRegistryGet.scoped).toBe(true);
    expect(capabilityRegistryGet.noBillingGate).toBe(true);
    expect(capabilityRegistryGet.defaultEffect).toBe("deny");
    expect(capabilityRegistryGet.defaultRoles.org).toMatchObject({
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
    });
  });

  it("declares the audit target so contract inspections are attributable", () => {
    expect(capabilityRegistryGet.audit).toEqual({
      targetKind: "capability",
      targetIdField: "name",
    });
  });

  it("declares the app layer (UI parity promise)", () => {
    expect(capabilityRegistryGet.layers).toEqual(
      expect.arrayContaining(["app"]),
    );
  });

  it("requires a non-empty name", () => {
    expect(() => capabilityRegistryGet.input.parse({})).toThrow();
    expect(() => capabilityRegistryGet.input.parse({ name: "" })).toThrow();
    expect(
      capabilityRegistryGet.input.parse({ name: "query_audit_log" }).name,
    ).toBe("query_audit_log");
  });

  it("accepts a null capability output (clean not-found)", () => {
    const parsed = capabilityRegistryGet.output.parse({ capability: null });
    expect(parsed.capability).toBeNull();
  });

  it("parses a full detail output", () => {
    const parsed = capabilityRegistryGet.output.parse({
      capability: {
        name: "query_audit_log",
        domain: "audit",
        description: "Query the audit spine",
        mode: "sync",
        surfaces: ["api", "mcp"],
        layers: ["api", "mcp"],
        sensitivity: "high",
        defaultEffect: "deny",
        scoped: true,
        noBillingGate: false,
        agent: null,
        auditTargetKind: null,
        plugin: {
          id: "oxagen/media-svg",
          tier: "premium",
          minPlanTier: "build",
        },
        orgRoles: { Owner: "allow" },
        workspaceRoles: {},
        inputFields: [
          {
            name: "source",
            type: "enum(all | security | playbook)",
            required: false,
            description: "spine",
          },
        ],
        outputFields: [
          {
            name: "events",
            type: "array<object>",
            required: true,
            description: null,
          },
        ],
        auditTargetIdField: null,
        produces: [],
        consumes: [],
        chainHints: ["query_audit_log"],
      },
    });
    expect(parsed.capability?.inputFields[0]?.required).toBe(false);
    expect(parsed.capability?.plugin?.minPlanTier).toBe("build");
  });
});
