/**
 * credit-gate.test.ts
 *
 * Unit tests for evaluateTurnCreditGate — the pre-turn credit admission gate
 * that mirrors the invoke()-wired assertCanStartTurn before the top-level model
 * turn. Locks in:
 *   (a) admitted   → { ok: true } when the shared gate resolves
 *   (b) blocked    → { ok: false, code: "insufficient_credits" } on an empty balance
 *   (c) blocked    → { ok: false, code: "billing_suspended" } on a suspended org
 *   (d) fail-open  → { ok: true } on any NON-billing (infra/DB) error, so a
 *                    metering hiccup never blocks a paying customer's turn
 *
 * @oxagen/billing is mocked so no DB or Stripe calls run; the mock supplies the
 * real error-class shapes the helper's `instanceof` checks depend on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @oxagen/billing — must be hoisted before importing ./credit-gate. ─────
class InsufficientCreditsError extends Error {
  readonly code = "insufficient_credits" as const;
  constructor() {
    super(
      "Insufficient credits: your balance is empty. Please add credits to continue.",
    );
    this.name = "InsufficientCreditsError";
  }
}
class BillingSuspendedError extends Error {
  readonly code = "billing_suspended" as const;
  constructor() {
    super("Billing suspended");
    this.name = "BillingSuspendedError";
  }
}
const assertCanStartTurnMock = vi.fn<(orgId: string) => Promise<void>>();

vi.mock("@oxagen/billing", () => ({
  assertCanStartTurn: (orgId: string) => assertCanStartTurnMock(orgId),
  InsufficientCreditsError,
  BillingSuspendedError,
}));

const { evaluateTurnCreditGate } = await import("./credit-gate");

describe("evaluateTurnCreditGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admits the turn when the shared gate resolves", async () => {
    assertCanStartTurnMock.mockResolvedValue(undefined);
    await expect(evaluateTurnCreditGate("org-1")).resolves.toEqual({
      ok: true,
    });
    expect(assertCanStartTurnMock).toHaveBeenCalledWith("org-1");
  });

  it("blocks with insufficient_credits on an affirmatively empty balance", async () => {
    assertCanStartTurnMock.mockRejectedValue(new InsufficientCreditsError());
    const result = await evaluateTurnCreditGate("org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("insufficient_credits");
      expect(result.message).toMatch(/balance is empty/i);
    }
  });

  it("blocks with billing_suspended on a suspended org", async () => {
    assertCanStartTurnMock.mockRejectedValue(new BillingSuspendedError());
    const result = await evaluateTurnCreditGate("org-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("billing_suspended");
    }
  });

  it("fails OPEN (admits) on a non-billing infra error", async () => {
    assertCanStartTurnMock.mockRejectedValue(
      new Error("connection reset by peer"),
    );
    await expect(evaluateTurnCreditGate("org-1")).resolves.toEqual({
      ok: true,
    });
  });
});
