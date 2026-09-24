/**
 * Unit tests for grantCreditLotOnce (grants.ts): the once-only grant the
 * prepaid-order grant runs on its own transaction.
 *
 * The ledger insert is `ON CONFLICT DO NOTHING` against the partial unique
 * index on `grant_%` reasons; a conflict returns no row, and then no lot and
 * no balance are written. The debt settlement and the balance mirror are
 * credits.ts's (tested there); here they are doubles that record the call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settleOwedCredits: vi.fn(),
  upsertBalanceMirror: vi.fn(),
}));

vi.mock("./credits", () => ({
  settleOwedCredits: mocks.settleOwedCredits,
  upsertBalanceMirror: mocks.upsertBalanceMirror,
}));
vi.mock("./subscriptions", () => ({ syncSubscriptionFromStripe: vi.fn() }));
vi.mock("./invoices", () => ({ syncInvoiceFromStripe: vi.fn() }));
vi.mock("./client", () => ({ billingProvider: vi.fn() }));

const { schema } = await import("@oxagen/database");
const { grantCreditLotOnce } = await import("./grants");
type Tx = import("@oxagen/database").Tx;

const ORG = "0192d4a8-7c1e-7a00-8000-00000000e001";
const ORDER = "0192d4a8-7c1e-7a00-8000-0000000000d1";
const NOW = new Date("2026-09-23T12:00:00.000Z");

/** A transaction whose ledger insert inserts once per reference, like the index. */
function makeTx() {
  const ledger = new Set<string>();
  const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
  const tx = {
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        if (table !== schema.creditLedger) return Promise.resolve(undefined);
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              const key = `${values.orgId}:${values.reason}:${values.referenceType}:${values.referenceId}`;
              if (ledger.has(key)) return [];
              ledger.add(key);
              return [{ id: "ledger-1" }];
            },
          }),
        };
      },
    })),
  };
  return { tx: tx as unknown as Tx, inserts };
}

const args = {
  orgId: ORG,
  reason: "grant_prepaid_invoice",
  referenceType: "prepaid_order",
  referenceId: ORDER,
  amountCents: 500_000n,
  source: "purchase" as const,
  grantedAt: NOW,
  expiresAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settleOwedCredits.mockResolvedValue(0n);
  mocks.upsertBalanceMirror.mockResolvedValue(undefined);
});

describe("grantCreditLotOnce", () => {
  it("writes the ledger row, then the lot, then settles debt and mirrors the balance", async () => {
    const { tx, inserts } = makeTx();

    expect(await grantCreditLotOnce(tx, args)).toBe(true);

    expect(inserts.map((i) => i.table)).toEqual([
      schema.creditLedger,
      schema.creditLots,
    ]);
    expect(inserts[0]!.values).toMatchObject({
      orgId: ORG,
      deltaCents: 500_000n,
      reason: "grant_prepaid_invoice",
      referenceType: "prepaid_order",
      referenceId: ORDER,
    });
    expect(inserts[1]!.values).toMatchObject({
      orgId: ORG,
      source: "purchase",
      originalCents: 500_000n,
      remainingCents: 500_000n,
      grantedAt: NOW,
      expiresAt: null,
    });
    expect(mocks.settleOwedCredits).toHaveBeenCalledWith(tx, ORG);
    expect(mocks.upsertBalanceMirror).toHaveBeenCalledOnce();
  });

  it("writes no lot and no balance when the reference was already granted", async () => {
    const { tx, inserts } = makeTx();
    await grantCreditLotOnce(tx, args);
    inserts.length = 0;
    vi.clearAllMocks();

    expect(await grantCreditLotOnce(tx, args)).toBe(false);

    expect(inserts.map((i) => i.table)).toEqual([schema.creditLedger]);
    expect(mocks.settleOwedCredits).not.toHaveBeenCalled();
    expect(mocks.upsertBalanceMirror).not.toHaveBeenCalled();
  });

  it("refuses a reason outside the grant_% index, which would never deduplicate", async () => {
    const { tx, inserts } = makeTx();
    await expect(
      grantCreditLotOnce(tx, { ...args, reason: "adjustment" }),
    ).rejects.toThrow(/not a grant_\* reason/);
    expect(inserts).toEqual([]);
  });

  it("refuses a zero grant", async () => {
    const { tx } = makeTx();
    await expect(
      grantCreditLotOnce(tx, { ...args, amountCents: 0n }),
    ).rejects.toThrow(/greater than zero/);
  });
});
