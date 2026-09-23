import { describe, expect, it } from "vitest";
import { workspaceList } from "./workspace.list";
import { getCapability } from "../registry";
import { capabilityMutates } from "../types";

describe("list_workspaces contract", () => {
  it("is registered", () => {
    expect(getCapability("list_workspaces")).toBe(workspaceList);
  });

  it("is a pre-tenant console read: scoped:false, mutates:false, noBillingGate:true", () => {
    expect(workspaceList.scoped).toBe(false);
    expect(capabilityMutates(workspaceList)).toBe(false);
    expect(workspaceList.noBillingGate).toBe(true);
  });

  it("leaves archived workspaces out unless asked (includeArchived defaults false)", () => {
    expect(workspaceList.input.parse({ orgSlug: "acme" }).includeArchived).toBe(
      false,
    );
    expect(
      workspaceList.input.parse({ orgSlug: "acme", includeArchived: true })
        .includeArchived,
    ).toBe(true);
  });

  it("requires a non-empty orgSlug", () => {
    expect(workspaceList.input.parse({ orgSlug: "acme" }).orgSlug).toBe("acme");
    expect(workspaceList.input.safeParse({ orgSlug: "" }).success).toBe(false);
    expect(workspaceList.input.safeParse({}).success).toBe(false);
  });

  it("a workspace's role is nullable for an org admin with no direct membership", () => {
    const organization = {
      id: "00000000-0000-0000-0000-000000000001",
      publicId: "org_1",
      slug: "acme",
      namespace: "acme",
      name: "Acme",
    };
    const workspace = {
      id: "00000000-0000-0000-0000-000000000002",
      publicId: "wrk_1",
      slug: "core",
      namespace: "core",
      name: "Core",
      role: null,
      archivedAt: null,
      costCenter: null,
    };
    expect(
      workspaceList.output.safeParse({ organization, workspaces: [workspace] })
        .success,
    ).toBe(true);
    const { role: _dropped, ...withoutRole } = workspace;
    expect(
      workspaceList.output.safeParse({
        organization,
        workspaces: [withoutRole],
      }).success,
    ).toBe(false);
  });
});
