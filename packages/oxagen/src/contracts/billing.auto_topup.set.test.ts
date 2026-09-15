import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { getSurfaces } from "../types";
import { billingAutoTopupSet } from "./billing.auto_topup.set";

describe("set_auto_topup contract", () => {
  it("is registered under its verb-first name", () => {
    expect(getCapability("set_auto_topup")).toBe(billingAutoTopupSet);
  });

  it("is a scoped customer write that the billing gate never sees", () => {
    expect(billingAutoTopupSet.mutates).toBe(true);
    expect(billingAutoTopupSet.scoped).toBe(true);
    expect(billingAutoTopupSet.noBillingGate).toBe(true);
    expect(billingAutoTopupSet.sensitivity).toBe("high");
    // Read through the registry rather than the exported literal: the kernel
    // checks `platformOnly` on the registered `CapabilityDeclaration`, where
    // the field is declared optional. The literal's inferred type omits a key
    // this contract never writes, so naming it there is a type error.
    expect(getCapability("set_auto_topup")?.platformOnly).toBeUndefined();
  });

  it("grants Owner and Admin, and no one else", () => {
    expect(billingAutoTopupSet.defaultEffect).toBe("deny");
    expect(billingAutoTopupSet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("carries no app layer until WL-50 binds the control", () => {
    expect(billingAutoTopupSet.layers).not.toContain("app");
    expect(billingAutoTopupSet.layers).not.toContain("e2e");
    expect(getSurfaces(billingAutoTopupSet)).toEqual(["api", "mcp"]);
  });

  it("accepts a whole number of blocks in 1…100 and refuses anything else", () => {
    expect(
      billingAutoTopupSet.input.parse({ enabled: true, blocks: 1 }),
    ).toEqual({ enabled: true, blocks: 1 });
    expect(
      billingAutoTopupSet.input.parse({ enabled: false, blocks: 100 }),
    ).toEqual({ enabled: false, blocks: 100 });

    for (const blocks of [0, -1, 101, 1.5]) {
      expect(
        billingAutoTopupSet.input.safeParse({ enabled: true, blocks }).success,
      ).toBe(false);
    }
  });

  it("refuses a missing field and an unknown one", () => {
    expect(billingAutoTopupSet.input.safeParse({ blocks: 2 }).success).toBe(
      false,
    );
    expect(billingAutoTopupSet.input.safeParse({ enabled: true }).success).toBe(
      false,
    );
    expect(
      billingAutoTopupSet.input.safeParse({
        enabled: true,
        blocks: 2,
        orgId: "00000000-0000-0000-0000-000000000001",
      }).success,
    ).toBe(false);
  });

  it("returns the two stored fields and nothing more", () => {
    expect(
      billingAutoTopupSet.output.parse({ enabled: true, blocks: 3 }),
    ).toEqual({ enabled: true, blocks: 3 });
    expect(
      billingAutoTopupSet.output.safeParse({
        enabled: true,
        blocks: 3,
        paymentMethod: null,
      }).success,
    ).toBe(false);
  });
});
