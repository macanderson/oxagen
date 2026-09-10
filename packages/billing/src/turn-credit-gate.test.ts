/**
 * turn-credit-gate.test.ts
 *
 * Unit tests for evaluateTurnCreditGate — the pre-turn credit admission gate
 * that mirrors the invoke()-wired assertCanStartTurn before the top-level model
 * turn. Locks in:
 *   (a) admitted   → { ok: true } when the shared gate resolves
 *   (b) blocked    → { ok: false, code: "insufficient_credits" } on an empty balance
 *   (c) blocked    → { ok: false, code: "billing_suspended" } on a suspended org
 *   (d) blocked    → { ok: false, code: "assistant_spend_cap" } once the month's
 *                    platform-paid assistant cap is spent (ADR-053 §3)
 *   (e) fail-open  → { ok: true } on any NON-billing (infra/DB) error, so a
 *                    metering hiccup never blocks a paying customer's turn
 *   (f) the funding source is forwarded to the shared gate, so a turn on the
 *       organisation's own key is not held to the cap
 *
 * ./metering is mocked so no DB or Stripe calls run; the mock supplies the
 * real error-class shapes the helper's `instanceof` checks depend on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock ./metering — must be hoisted before importing ./turn-credit-gate. ────
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
class AssistantSpendCapError extends Error {
  readonly code = "assistant_spend_cap" as const;
  constructor(
    readonly capCents: number,
    readonly spentCents: number,
  ) {
    super(
      `Assistant spend cap reached: this organisation has used ${spentCents} of its ${capCents} credits of platform-paid assistant usage this month.`,
    );
    this.name = "AssistantSpendCapError";
  }
}
const assertCanStartTurnMock =
  vi.fn<(orgId: string, opts?: { fundedBy?: string }) => Promise<void>>();

vi.mock("./metering", () => ({
  assertCanStartTurn: (orgId: string, opts?: { fundedBy?: string }) =>
    assertCanStartTurnMock(orgId, opts),
  InsufficientCreditsError,
  BillingSuspendedError,
  AssistantSpendCapError,
}));

const { evaluateTurnCreditGate } = await import("./turn-credit-gate");

describe("evaluateTurnCreditGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admits the turn when the shared gate resolves", async () => {
    assertCanStartTurnMock.mockResolvedValue(undefined);
    await expect(evaluateTurnCreditGate("org-1")).resolves.toEqual({
      ok: true,
    });
    expect(assertCanStartTurnMock).toHaveBeenCalledWith("org-1", {});
  });

  it("forwards the funding source to the shared gate (ADR-053 §3)", async () => {
    assertCanStartTurnMock.mockResolvedValue(undefined);
    await expect(
      evaluateTurnCreditGate("org-1", { fundedBy: "org" }),
    ).resolves.toEqual({ ok: true });
    expect(assertCanStartTurnMock).toHaveBeenCalledWith("org-1", {
      fundedBy: "org",
    });
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

  it("blocks with assistant_spend_cap once the month's platform-paid cap is spent", async () => {
    assertCanStartTurnMock.mockRejectedValue(
      new AssistantSpendCapError(2_000, 2_000),
    );
    const result = await evaluateTurnCreditGate("org-1", {
      fundedBy: "platform",
    });
    expect(result).toEqual({
      ok: false,
      code: "assistant_spend_cap",
      message: expect.stringMatching(/2000 of its 2000 credits/),
    });
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
