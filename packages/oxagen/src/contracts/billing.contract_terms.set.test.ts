import { afterEach, describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { getSurfaces, type CapabilityContext } from "../types";
import { clearHandlersForTests, invoke, registerHandler } from "../kernel";
import { createPlatformOperatorContext } from "../platform-operator";
import { billingContractTermsSet } from "./billing.contract_terms.set";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";

const valid = {
  orgId: ORG,
  agreementRef: "MSA-2026-014",
  currency: "usd",
  ratePerGauMicros: "3000",
  blockSizeGau: 10_000,
  includedGauPerMonth: 250_000,
};

/** What an operator script builds: no tenant, no user, surface "runner". */
const operatorCtx = (): CapabilityContext => ({
  orgId: "",
  workspaceId: "",
  userId: null,
  apiKeyId: null,
  requestId: "req-operator",
  surface: "runner",
  messageId: null,
});

describe("set_contract_terms contract", () => {
  afterEach(() => clearHandlersForTests());

  it("is registered under its verb-first name", () => {
    expect(getCapability("set_contract_terms")).toBe(billingContractTermsSet);
  });

  it("is a platform-operator write on no surface that no role grants", () => {
    expect(billingContractTermsSet.platformOnly).toBe(true);
    expect(billingContractTermsSet.scoped).toBe(false);
    expect(billingContractTermsSet.noBillingGate).toBe(true);
    expect(billingContractTermsSet.mutates).toBe(true);
    expect(billingContractTermsSet.sensitivity).toBe("high");
    expect(getSurfaces(billingContractTermsSet)).toEqual([]);
    expect(billingContractTermsSet.layers).toEqual(["schema", "unit", "docs"]);
    expect(billingContractTermsSet.defaultEffect).toBe("deny");
    expect(billingContractTermsSet.defaultRoles).toEqual({
      org: {},
      workspace: {},
    });
  });

  it("the kernel refuses it without a minted platform-operator binding, and runs it with one", async () => {
    let ran = 0;
    registerHandler("set_contract_terms", async () => async () => {
      ran += 1;
      return {
        ...valid,
        effectiveFrom: "2026-10-01T00:00:00.000Z",
        changed: true,
        previous: null,
      };
    });

    await expect(
      invoke("set_contract_terms", valid, operatorCtx()),
    ).rejects.toMatchObject({
      code: "authz_denied",
    });
    expect(ran).toBe(0);

    await invoke("set_contract_terms", valid, {
      ...operatorCtx(),
      platformOperator: createPlatformOperatorContext({
        requestId: "req-operator",
      }),
    });
    expect(ran).toBe(1);
  });

  it("takes the rate as digits, a positive block and non-negative included units", () => {
    expect(billingContractTermsSet.input.safeParse(valid).success).toBe(true);
    for (const over of [
      { ratePerGauMicros: "3.5" },
      { ratePerGauMicros: "-1" },
      { ratePerGauMicros: 3000 },
      { blockSizeGau: 0 },
      { includedGauPerMonth: -1 },
      { currency: "USD" },
      { agreementRef: "" },
      { orgId: "acme" },
      { effectiveFrom: "tomorrow" },
      { unknown: true },
    ]) {
      expect(
        billingContractTermsSet.input.safeParse({ ...valid, ...over }).success,
      ).toBe(false);
    }
  });

  it("accepts an effective date with an offset", () => {
    expect(
      billingContractTermsSet.input.safeParse({
        ...valid,
        effectiveFrom: "2026-10-01T00:00:00+02:00",
      }).success,
    ).toBe(true);
  });
});
