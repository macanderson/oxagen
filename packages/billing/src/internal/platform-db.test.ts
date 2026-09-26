/**
 * Billing opens its tenant transactions on the shared plane (#4338).
 *
 * ADR-042 §2 keeps billing tables on the shared plane for every organisation.
 * Credit grants from Stripe webhooks and settled usage (ADR-134) already land
 * there. Each case below calls one billing function inside a tenant scope and
 * records the options every `withTenantDb` and `withOrgDb` call received. A
 * call without `{ plane: "shared" }` opens on the organisation's own database
 * when it has one, where the turn credit gate would read an empty table.
 *
 * The transaction handle is a stand-in that answers any query chain with no
 * rows, so the functions run as far as an empty database lets them. What this
 * suite checks is the plane of each transaction they open, not the answers.
 * The rls-integration job checks the answers against two real planes
 * (`packages/billing/integration/usage-outbox-dedicated.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  tenantPlanes: [] as Array<string | undefined>,
  orgPlanes: [] as Array<string | undefined>,
  /** Answers for `findFirst` chains, in order. Empty means no row. */
  findFirst: [] as unknown[],
  /** Answers for `withSystemDb` calls, in order. Empty runs the callback. */
  system: [] as unknown[],
}));

/**
 * A transaction stand-in. Any property or call extends the query chain, and
 * awaiting the chain answers with no rows: `[]`, or `undefined` for a
 * `findFirst`. `roots` records the first property each query touched.
 */
function fakeTx(roots: string[] = []): unknown {
  const chain = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === "then") {
          const value = path.includes("findFirst")
            ? seams.findFirst.shift()
            : [];
          return (resolve: (v: unknown) => void) => resolve(value);
        }
        if (path.length === 0) roots.push(String(prop));
        return chain([...path, String(prop)]);
      },
      apply: () => chain(path),
    });
  return chain([]);
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: vi.fn(
      async (
        fn: (tx: unknown) => Promise<unknown>,
        opts?: { plane?: string },
      ) => {
        seams.tenantPlanes.push(opts?.plane);
        return fn(fakeTx());
      },
    ),
    withOrgDb: vi.fn(
      async (
        fn: (tx: unknown) => Promise<unknown>,
        opts?: { plane?: string },
      ) => {
        seams.orgPlanes.push(opts?.plane);
        return fn(fakeTx());
      },
    ),
    withSystemDb: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      seams.system.length > 0 ? seams.system.shift() : fn(fakeTx()),
    ),
  };
});

vi.mock("../client", () => ({
  billingProvider: () => ({
    customerExists: async () => false,
    createCustomer: async () => ({ id: "cus_new" }),
  }),
}));

import { runInTenantScope } from "@oxagen/tenancy";
import type { Tx } from "@oxagen/database";
import { CREDIT_REASONS } from "../constants";
import {
  consumeCredits,
  createCreditLot,
  effectiveBalance,
  owedCredits,
  readBalanceMirror,
} from "../credits";
import { assistantSpendThisMonth } from "../metering";
import {
  getOrgBillingSettings,
  readOrgBillingSettings,
  setAutoTopup,
  updateAssistantSpendCap,
  updateAutoReloadSettings,
} from "../billing-settings";
import { getOrgBillingStatus } from "../dunning";
import {
  grantProratedPlanUpgradeCredits,
  hasPlanUpgradeGrant,
} from "../grants";
import { ensureStripeCustomer } from "../customers";
import { readRecordedCustomerId } from "../recorded-customer";
import { admitUsage } from "../usage-outbox";
import {
  buildBillingStatement,
  postgresStatementReads,
} from "../statement-reads";

const ORG = "00000000-0000-0000-4338-000000000001";
const WORKSPACE = "00000000-0000-0000-4338-000000000010";

function settingsRow() {
  return {
    orgId: ORG,
    autoReloadEnabled: false,
    autoReloadThresholdCents: 500n,
    autoReloadAmountCents: 2_000n,
    autoReloadPaymentMethodId: null,
    lastAutoReloadAt: null,
    lowBalanceThresholdCents: 100n,
    assistantSpendCapCents: null,
    dunningState: "active",
    delinquentSince: null,
    graceEndsAt: null,
    suspendedAt: null,
  };
}

/** Run `fn` in a tenant scope. A throw from an empty answer is expected. */
async function inScope(fn: () => Promise<unknown>): Promise<void> {
  await runInTenantScope({ orgId: ORG, workspaceId: WORKSPACE }, fn).catch(
    () => undefined,
  );
}

beforeEach(() => {
  seams.tenantPlanes.length = 0;
  seams.orgPlanes.length = 0;
  seams.findFirst.length = 0;
  seams.system.length = 0;
});

describe("billing tenant transactions open on the shared plane", () => {
  const cases: Array<[string, () => Promise<unknown>, () => void]> = [
    ["effectiveBalance", () => effectiveBalance(ORG), () => {}],
    ["owedCredits", () => owedCredits(ORG), () => {}],
    ["readBalanceMirror", () => readBalanceMirror(ORG), () => {}],
    [
      "createCreditLot",
      () =>
        createCreditLot({
          orgId: ORG,
          amountCents: 500n,
          source: "purchase",
          expiresAt: null,
          reason: CREDIT_REASONS.GRANT_AUTO_RELOAD,
        }),
      () => {},
    ],
    [
      "consumeCredits without a caller transaction",
      () =>
        consumeCredits({
          orgId: ORG,
          reason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
          requestedCents: 5n,
        }),
      () => {},
    ],
    ["assistantSpendThisMonth", () => assistantSpendThisMonth(ORG), () => {}],
    ["getOrgBillingSettings", () => getOrgBillingSettings(ORG), () => {}],
    ["readOrgBillingSettings", () => readOrgBillingSettings(ORG), () => {}],
    [
      "setAutoTopup",
      () => setAutoTopup(ORG, { enabled: false, blocks: 1 }),
      () => {},
    ],
    [
      "updateAutoReloadSettings",
      () => updateAutoReloadSettings(ORG, { thresholdCents: 300 }),
      () => seams.findFirst.push(settingsRow(), settingsRow()),
    ],
    [
      "updateAssistantSpendCap",
      () => updateAssistantSpendCap(ORG, 1_000),
      () => seams.findFirst.push(settingsRow()),
    ],
    ["getOrgBillingStatus", () => getOrgBillingStatus(ORG), () => {}],
    [
      "hasPlanUpgradeGrant",
      () => hasPlanUpgradeGrant(ORG, "plan-to", new Date()),
      () => {},
    ],
    [
      "grantProratedPlanUpgradeCredits",
      () => grantProratedPlanUpgradeCredits(ORG, "plan-from", "plan-to"),
      () => {
        seams.system.push([
          { includedCreditCents: 0 },
          { includedCreditCents: 1_000 },
        ]);
        const now = Date.now();
        seams.findFirst.push({
          currentPeriodStart: new Date(now - 86_400_000),
          currentPeriodEnd: new Date(now + 86_400_000),
        });
      },
    ],
    ["readRecordedCustomerId", () => readRecordedCustomerId(ORG), () => {}],
    ["ensureStripeCustomer", () => ensureStripeCustomer(ORG), () => {}],
    ["admitUsage", () => admitUsage(ORG, WORKSPACE), () => {}],
  ];

  it.each(cases)("%s", async (_name, run, arrange) => {
    arrange();
    await inScope(run);
    expect(seams.tenantPlanes.length).toBeGreaterThan(0);
    expect(seams.tenantPlanes).toEqual(seams.tenantPlanes.map(() => "shared"));
  });

  it("opens every transaction of a plan upgrade grant on the shared plane", async () => {
    const [, , arrange] = cases.find(
      ([name]) => name === "grantProratedPlanUpgradeCredits",
    )!;
    arrange();
    await inScope(() =>
      grantProratedPlanUpgradeCredits(ORG, "plan-from", "plan-to"),
    );
    // The subscription lookup and the grant write.
    expect(seams.tenantPlanes).toEqual(["shared", "shared"]);
  });
});

describe("billing statement", () => {
  it("reads the credit ledger on a second, shared-plane transaction", async () => {
    await inScope(() =>
      buildBillingStatement(ORG, {
        kind: "month",
        start: new Date("2026-09-01T00:00:00Z"),
        end: new Date("2026-10-01T00:00:00Z"),
      } as never),
    );
    // The statement's own reads follow the organisation's plane. The credit
    // ledger reads open the shared one.
    expect(seams.orgPlanes).toEqual([undefined, "shared"]);
  });

  it("sends the three credit ledger reads to the credits transaction", async () => {
    const tenantRoots: string[] = [];
    const creditRoots: string[] = [];
    const reads = postgresStatementReads(
      fakeTx(tenantRoots) as Tx,
      fakeTx(creditRoots) as Tx,
    );
    const period = {
      start: new Date("2026-09-01T00:00:00Z"),
      end: new Date("2026-10-01T00:00:00Z"),
    };
    await reads.creditBalanceBefore(ORG, period.start);
    await reads.creditMovements(ORG, period);
    await reads.assistantByOperator(ORG, period);
    expect(creditRoots).toEqual(["select", "select", "select"]);
    expect(tenantRoots).toEqual([]);
  });
});
