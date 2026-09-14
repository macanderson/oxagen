import { describe, expect, it } from "vitest";
import { orgList } from "./org.list";
import { getCapability } from "../registry";
import { capabilityMutates } from "../types";

describe("list_orgs contract", () => {
  it("is registered", () => {
    expect(getCapability("list_orgs")).toBe(orgList);
  });

  it("is a pre-tenant console read: scoped:false, mutates:false, noBillingGate:true", () => {
    expect(orgList.scoped).toBe(false);
    expect(capabilityMutates(orgList)).toBe(false);
    expect(orgList.noBillingGate).toBe(true);
  });

  it("takes no input", () => {
    expect(orgList.input.parse({})).toEqual({});
  });

  it("an organization's avatarUrl is nullable and its role is not", () => {
    const org = {
      id: "00000000-0000-0000-0000-000000000001",
      publicId: "org_1",
      slug: "acme",
      namespace: "acme",
      name: "Acme",
      role: "owner",
      avatarUrl: null,
    };
    expect(orgList.output.safeParse({ organizations: [org] }).success).toBe(
      true,
    );
    const { role: _dropped, ...withoutRole } = org;
    expect(
      orgList.output.safeParse({ organizations: [withoutRole] }).success,
    ).toBe(false);
  });
});
