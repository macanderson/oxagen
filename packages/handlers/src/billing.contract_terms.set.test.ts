/**
 * Unit tests for the set_contract_terms handler.
 *
 * No role gate: reaching the handler is the authorization, and the kernel
 * owns that (INV-31; the contract test proves the refusal). Asserted here:
 * the input's figures reach the writer exactly (the rate as a bigint, the
 * effective date defaulting to now), a refused figure is invalid_input with
 * its reason, and the audit row is written, awaited, only when something
 * changed. The writer is negotiated-terms.ts's, tested in packages/billing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { billingContractTermsSet } from "@oxagen/oxagen/contracts/billing.contract_terms.set";
import {
  ContractTermsError,
  type NegotiatedTerms,
  type ReplacedNegotiatedTerms,
} from "@oxagen/billing";

const mocks = vi.hoisted(() => ({
  emitSecurityEventAsync: vi.fn<() => Promise<void>>(async () => {}),
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.emitSecurityEventAsync,
}));

import { createBillingContractTermsSetHandler } from "./billing.contract_terms.set";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000e001";
const NOW = new Date("2026-09-23T12:00:00.000Z");
const JAN = new Date("2026-01-01T00:00:00.000Z");

const operatorCtx = (): CapabilityContext => ({
  orgId: "",
  workspaceId: "",
  userId: null,
  apiKeyId: null,
  requestId: "req-operator",
  surface: "runner",
  messageId: null,
});

const input = (over: Record<string, unknown> = {}) =>
  billingContractTermsSet.input.parse({
    orgId: ORG,
    agreementRef: "MSA-2026-014",
    currency: "usd",
    ratePerGauMicros: "3000",
    blockSizeGau: 10_000,
    includedGauPerMonth: 250_000,
    ...over,
  });

function replaced(
  terms: NegotiatedTerms,
  changed = true,
): ReplacedNegotiatedTerms {
  return {
    current: { ...terms, id: "ct_new", effectiveTo: null },
    previous: changed
      ? {
          ...terms,
          id: "ct_old",
          agreementRef: "MSA-2025-003",
          effectiveFrom: JAN,
          effectiveTo: terms.effectiveFrom,
        }
      : null,
    changed,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emitSecurityEventAsync.mockResolvedValue(undefined);
});

describe("set_contract_terms handler", () => {
  it("hands the writer the input's figures, the rate as a bigint and the start defaulting to now", async () => {
    const replace = vi.fn(async (t: NegotiatedTerms) => replaced(t));
    const handler = createBillingContractTermsSetHandler({
      replace,
      now: () => NOW,
    });

    const out = await handler(input(), operatorCtx());

    expect(replace).toHaveBeenCalledWith({
      orgId: ORG,
      agreementRef: "MSA-2026-014",
      currency: "usd",
      ratePerGauMicros: 3_000n,
      blockSizeGau: 10_000,
      includedGauPerMonth: 250_000,
      effectiveFrom: NOW,
    });
    expect(out).toEqual({
      orgId: ORG,
      agreementRef: "MSA-2026-014",
      currency: "usd",
      ratePerGauMicros: "3000",
      blockSizeGau: 10_000,
      includedGauPerMonth: 250_000,
      effectiveFrom: NOW.toISOString(),
      changed: true,
      previous: {
        agreementRef: "MSA-2025-003",
        effectiveFrom: JAN.toISOString(),
        effectiveTo: NOW.toISOString(),
      },
    });
    expect(() => billingContractTermsSet.output.parse(out)).not.toThrow();
  });

  it("starts the terms at the given instant", async () => {
    const replace = vi.fn(async (t: NegotiatedTerms) => replaced(t));
    await createBillingContractTermsSetHandler({ replace })(
      input({ effectiveFrom: "2026-10-01T00:00:00+00:00" }),
      operatorCtx(),
    );
    expect(replace.mock.calls[0]![0].effectiveFrom).toEqual(
      new Date("2026-10-01T00:00:00.000Z"),
    );
  });

  it("audits a change against the target org, awaited, with the operator run's request id", async () => {
    const replace = vi.fn(async (t: NegotiatedTerms) => replaced(t));
    await createBillingContractTermsSetHandler({ replace, now: () => NOW })(
      input(),
      operatorCtx(),
    );
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledWith({
      eventType: "billing.plan_changed",
      actorUserId: null,
      orgId: ORG,
      workspaceId: null,
      capability: "set_contract_terms",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: "req-operator",
    });
  });

  it("writes no audit row when the terms were already in force", async () => {
    const replace = vi.fn(async (t: NegotiatedTerms) => replaced(t, false));
    const out = await createBillingContractTermsSetHandler({
      replace,
      now: () => NOW,
    })(input(), operatorCtx());
    expect(out).toMatchObject({ changed: false, previous: null });
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("turns a refused figure into invalid_input naming the reason", async () => {
    const replace = vi.fn(async () => {
      throw new ContractTermsError(
        "block_not_whole_cents",
        "A block costs 333.3 cents.",
      );
    });
    await expect(
      createBillingContractTermsSetHandler({ replace })(input(), operatorCtx()),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "block_not_whole_cents: A block costs 333.3 cents.",
    });
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("rethrows any other failure unchanged", async () => {
    const replace = vi.fn(async () => {
      throw new Error("connection reset");
    });
    await expect(
      createBillingContractTermsSetHandler({ replace })(input(), operatorCtx()),
    ).rejects.toThrow("connection reset");
  });
});
