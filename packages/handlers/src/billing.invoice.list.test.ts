/**
 * Unit tests for the list_invoices handler.
 *
 * The org is tier-free in every case: the kernel's IAM check allows every
 * capability there, so the refusals below come from the handler alone. The
 * role gate runs for real against a tx double that answers the principal and
 * role-assignment tables; the invoice read runs against an in-memory store
 * that applies the same org fence, draft exclusion, ordering, cursor and page
 * semantics as the Postgres query it stands in for, so a test proves paging
 * and scoping behaviour rather than the shape of a canned reply. The query
 * itself is checked by its SQL.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { billingInvoiceList } from "@oxagen/oxagen/contracts/billing.invoice.list";
import { schema } from "@oxagen/database";
import { drizzle } from "drizzle-orm/postgres-js";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  centsToMicros,
  createBillingInvoiceListHandler,
  decodeInvoiceCursor,
  encodeInvoiceCursor,
  invoiceKind,
  invoicePageQuery,
  type InvoiceRow,
  type PageQuery,
  postgresInvoiceQueries,
} from "./billing.invoice.list";
import { makeCTX } from "./test-utils/fixtures";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const OTHER_ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3f";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";

const ctx = (
  over: {
    orgId?: string;
    userId?: string | null;
    apiKeyId?: string | null;
  } = {},
) => makeCTX({ orgId: ORG, userId: USER, ...over });

/** An API-key call: no signed-in user, the key's id. */
const keyCall = () => ctx({ userId: null, apiKeyId: KEY });

// ── role-gate tx double ───────────────────────────────────────────────────────

/** The user the API key in these tests was created by, and the key. */
const KEY_CREATOR = "0192d4a8-7c1e-7a00-8000-0000000c7ea7";
const KEY = "0192d4a8-7c1e-7a00-8000-0000000a91e1";

/**
 * Answers by the table asked for, so query order does not matter: the API
 * key's creator (`keyCreator`, null for a key with none), the principal and
 * the org role.
 */
function stubRole(
  roleName: string | null,
  keyCreator: string | null = KEY_CREATOR,
) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.apiKeys)
      return keyCreator ? [{ createdById: keyCreator }] : [];
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

// ── in-memory invoice store ───────────────────────────────────────────────────

type Settlement = { orgId: string; stripeInvoiceId: string; kind: string };

type StoredInvoice = Omit<InvoiceRow, "settlementKind"> & {
  orgId: string;
  stripeInvoiceId: string;
  subscriptionId: string | null;
};

let seq = 0;
const uuid = (n: number) =>
  `0192d4a8-7c1e-7a00-8000-${String(n).padStart(12, "0")}`;

function invoice(
  over: Partial<StoredInvoice> & { publicId: string },
): StoredInvoice {
  seq += 1;
  return {
    id: uuid(seq),
    orgId: ORG,
    stripeInvoiceId: `in_${over.publicId}`,
    subscriptionId: uuid(9000),
    number: `OXG-${String(seq).padStart(4, "0")}`,
    status: "paid",
    amountDueCents: 2500,
    amountPaidCents: 2500,
    currency: "usd",
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
    periodEnd: new Date("2026-10-01T00:00:00.000Z"),
    hostedInvoiceUrl: `https://invoice.stripe.com/i/acct_1/${over.publicId}`,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)),
    ...over,
  };
}

/** The Postgres query's semantics over arrays: fence, exclude, join, order, cursor, limit + 1. */
function memoryPage(rows: StoredInvoice[], settlements: Settlement[] = []) {
  return async (orgId: string, q: PageQuery): Promise<InvoiceRow[]> =>
    rows
      .filter((r) => r.orgId === orgId && r.status !== "draft")
      .filter((r) => {
        if (!q.cursor) return true;
        const at = Date.parse(q.cursor.at);
        const t = r.createdAt.getTime();
        return t < at || (t === at && r.id < q.cursor.id);
      })
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .slice(0, q.limit + 1)
      .map((r) => ({
        ...r,
        settlementKind:
          settlements.find(
            (s) =>
              s.orgId === r.orgId && s.stripeInvoiceId === r.stripeInvoiceId,
          )?.kind ?? null,
      }));
}

const handlerOver = (rows: StoredInvoice[], settlements: Settlement[] = []) =>
  createBillingInvoiceListHandler({ page: memoryPage(rows, settlements) });

const forbidden = (e: unknown) => isHandlerError(e) && e.code === "forbidden";
const refused = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "forbidden" && e.reason === reason;

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  stubRole("Owner");
});

// ── role gate ─────────────────────────────────────────────────────────────────

describe("list_invoices — role gate", () => {
  it.each(["Member", "Viewer", "Compliance"])(
    "refuses a %s with HandlerError forbidden and reads no invoice (negative)",
    async (role) => {
      stubRole(role);
      const page = vi.fn();
      const list = createBillingInvoiceListHandler({ page });
      await expect(list({ limit: 50 }, ctx())).rejects.toSatisfy(forbidden);
      expect(page).not.toHaveBeenCalled();
    },
  );

  it("refuses a user with no org role and a context with no user (negative)", async () => {
    stubRole(null);
    const page = vi.fn();
    const list = createBillingInvoiceListHandler({ page });
    await expect(list({ limit: 50 }, ctx())).rejects.toSatisfy(forbidden);
    await expect(list({ limit: 50 }, ctx({ userId: null }))).rejects.toSatisfy(
      forbidden,
    );
    expect(page).not.toHaveBeenCalled();
  });

  it("lists for an API key whose creator is an org Admin", async () => {
    stubRole("Admin");
    const list = handlerOver([invoice({ publicId: "inv_a" })]);
    const out = await list({ limit: 50 }, keyCall());
    expect(out.items.map((i) => i.publicId)).toEqual(["inv_a"]);
  });

  it("refuses an API key whose creator is an org Member, and a key with no creator (negative)", async () => {
    const page = vi.fn();
    const list = createBillingInvoiceListHandler({ page });
    stubRole("Member");
    await expect(list({ limit: 50 }, keyCall())).rejects.toSatisfy(
      refused("org_role_required"),
    );
    stubRole("Owner", null);
    await expect(list({ limit: 50 }, keyCall())).rejects.toSatisfy(
      refused("no_principal"),
    );
    expect(page).not.toHaveBeenCalled();
  });

  it.each(["Owner", "Admin", "Billing"])("lists for a %s", async (role) => {
    stubRole(role);
    const list = handlerOver([invoice({ publicId: "inv_a" })]);
    const out = await list({ limit: 50 }, ctx());
    expect(out.items.map((i) => i.publicId)).toEqual(["inv_a"]);
  });
});

// ── the list ──────────────────────────────────────────────────────────────────

describe("list_invoices", () => {
  it("lists the caller's organization only, newest first, drafts excluded", async () => {
    const list = handlerOver([
      invoice({ publicId: "inv_old" }),
      invoice({ publicId: "inv_other", orgId: OTHER_ORG }),
      invoice({ publicId: "inv_draft", status: "draft", number: null }),
      invoice({ publicId: "inv_new", status: "open", amountPaidCents: 0 }),
    ]);
    const out = await list({ limit: 50 }, ctx());
    expect(billingInvoiceList.output.parse(out)).toEqual(out);
    expect(out.items.map((i) => i.publicId)).toEqual(["inv_new", "inv_old"]);
    expect(out.nextCursor).toBeNull();

    const other = await list({ limit: 50 }, ctx({ orgId: OTHER_ORG }));
    expect(other.items.map((i) => i.publicId)).toEqual(["inv_other"]);
  });

  it("labels a subscription invoice, a GAU purchase with no subscription, and every settlement kind", async () => {
    const rows = [
      invoice({ publicId: "inv_sub" }),
      invoice({ publicId: "inv_buy", subscriptionId: null }),
      invoice({ publicId: "inv_topup" }),
      invoice({ publicId: "inv_interim" }),
      invoice({ publicId: "inv_close" }),
    ];
    const list = handlerOver(rows, [
      { orgId: ORG, stripeInvoiceId: "in_inv_buy", kind: "checkout" },
      { orgId: ORG, stripeInvoiceId: "in_inv_topup", kind: "auto_topup" },
      {
        orgId: ORG,
        stripeInvoiceId: "in_inv_interim",
        kind: "interim_invoice",
      },
      { orgId: ORG, stripeInvoiceId: "in_inv_close", kind: "period_close" },
    ]);
    const out = await list({ limit: 50 }, ctx());
    expect(
      Object.fromEntries(out.items.map((i) => [i.publicId, i.kind])),
    ).toEqual({
      inv_sub: "subscription",
      inv_buy: "gau_purchase",
      inv_topup: "gau_auto_topup",
      inv_interim: "gau_interim",
      inv_close: "gau_period_close",
    });
  });

  it("lists an open interim invoice of a card-less org with the mirror's status and hosted URL", async () => {
    const list = handlerOver(
      [
        invoice({
          publicId: "inv_interim",
          status: "open",
          amountDueCents: 50_000,
          amountPaidCents: 0,
          hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_1/pay_me",
        }),
      ],
      [
        {
          orgId: ORG,
          stripeInvoiceId: "in_inv_interim",
          kind: "interim_invoice",
        },
      ],
    );
    const out = await list({ limit: 50 }, ctx());
    expect(out.items).toEqual([
      expect.objectContaining({
        publicId: "inv_interim",
        kind: "gau_interim",
        status: "open",
        amountDueMicros: "500000000",
        amountPaidMicros: "0",
        currency: "usd",
        hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_1/pay_me",
      }),
    ]);
  });

  it("carries a null number and a null hosted URL as null", async () => {
    const list = handlerOver([
      invoice({ publicId: "inv_x", number: null, hostedInvoiceUrl: null }),
    ]);
    const out = await list({ limit: 50 }, ctx());
    expect(out.items[0]).toMatchObject({
      number: null,
      hostedInvoiceUrl: null,
    });
  });

  it("pages from the cursor with no duplicate and no gap, ties at one instant included", async () => {
    const same = new Date("2026-09-10T12:00:00.000Z");
    const rows = [
      invoice({ publicId: "inv_1" }),
      invoice({ publicId: "inv_2", createdAt: same }),
      invoice({ publicId: "inv_3", createdAt: same }),
      invoice({ publicId: "inv_4", createdAt: same }),
      invoice({
        publicId: "inv_5",
        createdAt: new Date("2026-09-11T00:00:00.000Z"),
      }),
    ];
    const list = handlerOver(rows);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const out = await list({ limit: 2, cursor }, ctx());
      expect(out.items.length).toBeLessThanOrEqual(2);
      seen.push(...out.items.map((i) => i.publicId));
      cursor = out.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(["inv_5", "inv_4", "inv_3", "inv_2", "inv_1"]);
  });

  it("answers no next cursor when the page is exactly full", async () => {
    const list = handlerOver([
      invoice({ publicId: "inv_1" }),
      invoice({ publicId: "inv_2" }),
    ]);
    const out = await list({ limit: 2 }, ctx());
    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBeNull();
  });

  it("refuses a cursor it did not write as invalid_input (negative)", async () => {
    const page = vi.fn();
    const list = createBillingInvoiceListHandler({ page });
    for (const bad of [
      "not-a-cursor",
      Buffer.from('["2026-09-10T12:00:00.000Z","inv_abc"]').toString(
        "base64url",
      ),
      Buffer.from(
        '["yesterday","0192d4a8-7c1e-7a00-8000-000000000001"]',
      ).toString("base64url"),
      Buffer.from('{"at":"2026-09-10T12:00:00.000Z"}').toString("base64url"),
    ]) {
      await expect(list({ limit: 2, cursor: bad }, ctx())).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof CapabilityError &&
          e.code === "invalid_input" &&
          e.capability === "list_invoices",
      );
    }
    expect(page).not.toHaveBeenCalled();
  });

  it("round-trips its own cursor", () => {
    const cursor = { at: "2026-09-10T12:00:00.000Z", id: uuid(7) };
    expect(decodeInvoiceCursor(encodeInvoiceCursor(cursor))).toEqual(cursor);
  });

  it("fails on a settlement kind or a status outside the CHECK rather than guessing (negative)", async () => {
    await expect(
      handlerOver(
        [invoice({ publicId: "inv_x" })],
        [{ orgId: ORG, stripeInvoiceId: "in_inv_x", kind: "refund" }],
      )({ limit: 50 }, ctx()),
    ).rejects.toThrow(RangeError);
    await expect(
      handlerOver([invoice({ publicId: "inv_y", status: "pending" })])(
        { limit: 50 },
        ctx(),
      ),
    ).rejects.toThrow(RangeError);
    expect(invoiceKind(null)).toBe("subscription");
  });

  it("scales cents to micro-units exactly and refuses a non-integer", () => {
    expect(centsToMicros(0)).toBe("0");
    expect(centsToMicros(2500)).toBe("25000000");
    expect(centsToMicros(-150)).toBe("-1500000");
    expect(centsToMicros(Number.MAX_SAFE_INTEGER)).toBe("90071992547409910000");
    expect(() => centsToMicros(1.5)).toThrow(RangeError);
  });
});

// ── the query ─────────────────────────────────────────────────────────────────

describe("list_invoices query", () => {
  const db = drizzle.mock({ schema });
  const page = { cursor: null, limit: 50 };

  it("fences on org_id, excludes drafts and reads one row past the page", () => {
    const query = invoicePageQuery(db, ORG, page).toSQL();
    expect(query.sql).toMatch(/"invoices"\."org_id" = \$\d+/);
    expect(query.sql).toMatch(/"invoices"\."status" <> \$\d+/);
    expect(query.params).toEqual(expect.arrayContaining([ORG, "draft", 51]));
  });

  it("a different org binds a different id (negative)", () => {
    const query = invoicePageQuery(db, OTHER_ORG, page).toSQL();
    expect(query.params).not.toContain(ORG);
    expect(query.params).toContain(OTHER_ORG);
  });

  it("left-joins the settlement on stripe_invoice_id within the org for the kind", () => {
    const query = invoicePageQuery(db, ORG, page).toSQL();
    expect(query.sql).toMatch(
      /left join "billing"\."gau_settlements" on \("billing"\."gau_settlements"\."stripe_invoice_id" = "billing"\."invoices"\."stripe_invoice_id" and "billing"\."gau_settlements"\."org_id" = "billing"\."invoices"\."org_id"\)/,
    );
    expect(query.sql).toMatch(/"gau_settlements"\."kind"/);
  });

  it("orders newest first by created_at then id, and applies the cursor at millisecond precision", () => {
    const query = invoicePageQuery(db, ORG, page).toSQL();
    expect(query.sql).toMatch(
      /order by date_trunc\('milliseconds', "billing"\."invoices"\."created_at"\) desc, "billing"\."invoices"\."id" desc/,
    );
    const cursor = { at: "2026-09-10T12:00:00.000Z", id: uuid(7) };
    const paged = invoicePageQuery(db, ORG, { cursor, limit: 10 }).toSQL();
    expect(paged.sql).toMatch(/"invoices"\."id" < \$\d+/);
    expect(paged.params).toEqual(
      expect.arrayContaining([new Date(cursor.at), uuid(7), 11]),
    );
  });

  it("runs inside the tenant scope", async () => {
    const seen: unknown[] = [];
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) => {
      const tx = {
        select: () => ({
          from: () => ({
            leftJoin: () => ({
              where: () => ({
                orderBy: () => ({ limit: () => Promise.resolve(seen) }),
              }),
            }),
          }),
        }),
      };
      return Promise.resolve(fn(tx));
    });
    await expect(postgresInvoiceQueries.page(ORG, page)).resolves.toBe(seen);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });
});
