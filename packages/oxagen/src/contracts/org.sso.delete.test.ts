import { describe, expect, it } from "vitest";
import { orgSsoDelete } from "./org.sso.delete";
import { getCapability } from "../registry";

describe("org.sso.delete capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("delete_sso_provider")).toBe(orgSsoDelete);
  });

  it("is governed: org-admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgSsoDelete.scoped).toBe(false);
    expect(orgSsoDelete.sensitivity).toBe("high");
    expect(orgSsoDelete.defaultEffect).toBe("deny");
    expect(orgSsoDelete.noBillingGate).toBe(true);
    expect(orgSsoDelete.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgSsoDelete.surfaces).toEqual(["api", "mcp"]);
  });

  it("is not an agent tool: the in-app agent never reconfigures sign-in", () => {
    expect("agent" in orgSsoDelete).toBe(false);
  });

  it("takes a provider id and returns deleted: true", () => {
    expect(orgSsoDelete.input.parse({ providerId: "acme" })).toEqual({
      providerId: "acme",
    });
    expect(orgSsoDelete.output.parse({ deleted: true })).toEqual({
      deleted: true,
    });
  });
});
