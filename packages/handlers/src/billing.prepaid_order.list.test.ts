/**
 * Unit tests for the list_prepaid_orders handler.
 *
 * The role gate runs for real against a tx double that answers the API-key,
 * principal and role-assignment tables, so the refusals come from the handler
 * alone (the kernel's IAM check allows every capability for a tier-free org).
 * The page read is an injected double; the query it stands in for is checked
 * by its SQL against drizzle's mock driver, predicate by predicate.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { billingPrepaidOrderList } from "@oxagen/oxagen/contracts/billing.prepaid_order.list";
import { schema } from "@oxagen/database";
import { drizzle } from "drizzle-orm/postgres-js";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  createBillingPrepaidOrderListHandler,
  prepaidOrderPageQuery,
  type OrderPageQuery,
  type PrepaidOrderPageRow,
} from "./billing.prepaid_order.list";
import { makeCTX } from "./test-utils/fixtures";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const OTHER_ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3f";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const KEY = "0192d4a8-7c1e-7a00-8000-0000000a91e1";
const KEY_CREATOR = "0192d4a8-7c1e-7a00-8000-0000000c7ea7";

const ctx = (over: { userId?: string | null; apiKeyId?: string | null } = {}) =>
  makeCTX({ orgId: ORG, userId: USER, ...over });

function stubRole(roleName: string | null) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.apiKeys) return [{ createdById: KEY_CREATOR }];
    if (table === schema.principals) return [{ id: "prn_1" }];
    if (table === schema.principalRoleAssignments)
      return roleName ? [{ roleName }] : [];
    throw new Error("unexpected table");
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: (table: unknown) => {
            const chain = {
              innerJoin: () => chain,
              where: () => chain,
              limit: () => Promise.resolve(rowsFor(table)),
            };
            return chain;
          },
        }),
      }),
    ),
  );
}

const uuid = (n: number) =>
  `0192d4a8-7c1e-7a00-8000-${String(n).padStart(12, "0")}`;

function row(
  n: number,
  over: Partial<PrepaidOrderPageRow> = {},
): PrepaidOrderPageRow {
  return {
    order: {
      id: uuid(n),
      orgId: ORG,
      agreementRef: "MSA-2026-014",
      poNumber: "PO-7781",
      currency: "usd",
      licenceCents: 12_000_000,
      licencePeriodStart: new Date("2026-10-01T00:00:00.000Z"),
      licencePeriodEnd: new Date("2027-10-01T00:00:00.000Z"),
      gauQuantity: 2_000_000,
      ratePerGauMicros: 3_000n,
      creditCents: 500_000,
      grantOn: "paid",
      status: "paid",
      daysUntilDue: 30,
      memo: null,
      stripeInvoiceId: `in_${n}`,
      grantedBucketId: null,
      unitsGrantedAt: new Date("2026-10-10T00:00:00.000Z"),
      creditsGrantedAt: new Date("2026-10-10T00:00:00.000Z"),
      issuedByRequestId: "req-1",
      createdAt: new Date(Date.UTC(2026, 8, 23, 0, 0, n)),
      updatedAt: new Date(Date.UTC(2026, 8, 23, 0, 0, n)),
      paidAt: new Date("2026-10-10T00:00:00.000Z"),
    },
    invoiceNumber: `OXA-${n}`,
    invoiceStatus: "paid",
    invoiceDueAt: new Date("2026-10-23T00:00:00.000Z"),
    hostedInvoiceUrl: `https://invoice.stripe.com/i/${n}`,
    invoicePdfUrl: `https://invoice.stripe.com/i/${n}.pdf`,
    ...over,
  };
}

const input = (over: Record<string, unknown> = {}) =>
  billingPrepaidOrderList.input.parse({ ...over });

beforeEach(() => {
  vi.clearAllMocks();
  stubRole("Billing");
});

describe("list_prepaid_orders role gate", () => {
  it.each(["Owner", "Admin", "Billing"])("admits an org %s", async (role) => {
    stubRole(role);
    const page = vi.fn(async () => [row(1)]);
    const out = await createBillingPrepaidOrderListHandler({ page })(
      input(),
      ctx(),
    );
    expect(out.items).toHaveLength(1);
  });

  it("refuses a Member before reading anything", async () => {
    stubRole("Member");
    const page = vi.fn();
    const err = await createBillingPrepaidOrderListHandler({ page })(
      input(),
      ctx(),
    ).catch((e: unknown) => e);
    expect(isHandlerError(err) && err.code).toBe("forbidden");
    expect(page).not.toHaveBeenCalled();
  });

  it("admits an API-key call as the key's creator", async () => {
    stubRole("Owner");
    const page = vi.fn(async () => []);
    await expect(
      createBillingPrepaidOrderListHandler({ page })(
        input(),
        ctx({ userId: null, apiKeyId: KEY }),
      ),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });
});

describe("list_prepaid_orders mapping", () => {
  it("prints each order's lines as its invoice did, in micro-units, with the mirrored invoice", async () => {
    const page = vi.fn(async () => [row(1)]);
    const out = await createBillingPrepaidOrderListHandler({ page })(
      input(),
      ctx(),
    );

    expect(page).toHaveBeenCalledWith(ORG, { cursor: null, limit: 50 });
    expect(out.items[0]).toEqual({
      orderId: uuid(1),
      status: "paid",
      agreementRef: "MSA-2026-014",
      poNumber: "PO-7781",
      currency: "usd",
      lines: [
        {
          kind: "licence",
          description:
            "Oxagen platform licence (agreement MSA-2026-014): 1 Oct 2026 to 30 Sep 2027",
          quantity: 1,
          amountMicros: "120000000000",
          periodStart: "2026-10-01T00:00:00.000Z",
          periodEnd: "2027-10-01T00:00:00.000Z",
        },
        {
          kind: "gau",
          description:
            "Governed action units, prepaid: 2,000,000 GAU at $3.00 per 1,000",
          quantity: 2_000_000,
          amountMicros: "6000000000",
          periodStart: null,
          periodEnd: null,
        },
        {
          kind: "credits",
          description:
            "Usage credits for the in-app assistant, prepaid: $5,000.00 (500,000 credits)",
          quantity: 1,
          amountMicros: "5000000000",
          periodStart: null,
          periodEnd: null,
        },
      ],
      totalMicros: "131000000000",
      grantOn: "paid",
      unitsGrantedAt: "2026-10-10T00:00:00.000Z",
      creditsGrantedAt: "2026-10-10T00:00:00.000Z",
      paidAt: "2026-10-10T00:00:00.000Z",
      createdAt: "2026-09-23T00:00:01.000Z",
      invoice: {
        number: "OXA-1",
        status: "paid",
        dueAt: "2026-10-23T00:00:00.000Z",
        hostedInvoiceUrl: "https://invoice.stripe.com/i/1",
        invoicePdfUrl: "https://invoice.stripe.com/i/1.pdf",
      },
    });
    expect(() => billingPrepaidOrderList.output.parse(out)).not.toThrow();
  });

  it("reports no invoice until the webhook has mirrored it", async () => {
    const page = vi.fn(async () => [
      row(1, {
        invoiceNumber: null,
        invoiceStatus: null,
        invoiceDueAt: null,
        hostedInvoiceUrl: null,
        invoicePdfUrl: null,
      }),
    ]);
    const out = await createBillingPrepaidOrderListHandler({ page })(
      input(),
      ctx(),
    );
    expect(out.items[0]!.invoice).toBeNull();
  });

  it("fails on a status outside the CHECK rather than guess", async () => {
    const broken = row(1);
    broken.order.status = "refunded";
    const page = vi.fn(async () => [broken]);
    await expect(
      createBillingPrepaidOrderListHandler({ page })(input(), ctx()),
    ).rejects.toThrow(RangeError);
  });
});

describe("list_prepaid_orders paging", () => {
  it("returns a cursor when a row past the page exists, and the next page starts after it", async () => {
    const all = [row(3), row(2), row(1)];
    const page = vi.fn(async (_org: string, q: OrderPageQuery) => {
      const start = q.cursor
        ? all.findIndex((r) => r.order.id === q.cursor!.id) + 1
        : 0;
      return all.slice(start, start + q.limit + 1);
    });
    const handler = createBillingPrepaidOrderListHandler({ page });

    const first = await handler(input({ limit: 2 }), ctx());
    expect(first.items.map((i) => i.orderId)).toEqual([uuid(3), uuid(2)]);
    expect(first.nextCursor).not.toBeNull();

    const second = await handler(
      input({ limit: 2, cursor: first.nextCursor! }),
      ctx(),
    );
    expect(page).toHaveBeenLastCalledWith(ORG, {
      cursor: { at: all[1]!.order.createdAt.toISOString(), id: uuid(2) },
      limit: 2,
    });
    expect(second.items.map((i) => i.orderId)).toEqual([uuid(1)]);
    expect(second.nextCursor).toBeNull();
  });

  it.each(["not-a-cursor", Buffer.from('["x","y"]').toString("base64url")])(
    "refuses a cursor it did not write (%s)",
    async (cursor) => {
      const page = vi.fn();
      await expect(
        createBillingPrepaidOrderListHandler({ page })(
          input({ cursor }),
          ctx(),
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(page).not.toHaveBeenCalled();
    },
  );
});

describe("list_prepaid_orders query", () => {
  const db = drizzle.mock({ schema });
  const page = { cursor: null, limit: 50 };

  it("fences on org_id, excludes drafts and reads one row past the page", () => {
    const query = prepaidOrderPageQuery(db, ORG, page).toSQL();
    expect(query.sql).toMatch(/"prepaid_orders"\."org_id" = \$\d+/);
    expect(query.sql).toMatch(/"prepaid_orders"\."status" <> \$\d+/);
    expect(query.params).toEqual(expect.arrayContaining([ORG, "draft", 51]));
  });

  it("a different org binds a different id (negative)", () => {
    const query = prepaidOrderPageQuery(db, OTHER_ORG, page).toSQL();
    expect(query.params).not.toContain(ORG);
    expect(query.params).toContain(OTHER_ORG);
  });

  it("left-joins the invoice mirror on stripe_invoice_id within the org", () => {
    const query = prepaidOrderPageQuery(db, ORG, page).toSQL();
    expect(query.sql).toMatch(
      /left join "billing"\."invoices" on \("billing"\."invoices"\."stripe_invoice_id" = "billing"\."prepaid_orders"\."stripe_invoice_id" and "billing"\."invoices"\."org_id" = "billing"\."prepaid_orders"\."org_id"\)/,
    );
  });

  it("orders newest first by created_at then id, and applies the cursor at millisecond precision", () => {
    const query = prepaidOrderPageQuery(db, ORG, page).toSQL();
    expect(query.sql).toMatch(
      /order by date_trunc\('milliseconds', "billing"\."prepaid_orders"\."created_at"\) desc, "billing"\."prepaid_orders"\."id" desc/,
    );
    const cursor = { at: "2026-09-23T12:00:00.000Z", id: uuid(7) };
    const paged = prepaidOrderPageQuery(db, ORG, { cursor, limit: 10 }).toSQL();
    expect(paged.sql).toMatch(/"prepaid_orders"\."id" < \$\d+/);
    expect(paged.params).toEqual(
      expect.arrayContaining([new Date(cursor.at), uuid(7), 11]),
    );
  });
});
