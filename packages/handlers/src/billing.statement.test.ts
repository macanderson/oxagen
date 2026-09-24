/**
 * Unit tests for the get_billing_statement and export_billing_statement
 * handlers.
 *
 * The role gate is a module double that records what it was asked; the
 * statement, the line items and the clock are injected. The statement's own
 * arithmetic and reads are tested in @oxagen/billing (statements.test.ts,
 * statements.pg.test.ts, statement-render.test.ts); here the tests prove the
 * handler's part: who may ask, which period it asks for, how a refusal is
 * worded, and which CSV page carries the header.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { HandlerError } from "@oxagen/oxagen";
import type { BillingStatement } from "@oxagen/oxagen/contracts/billing.statement.get";
import type { StatementLineItem } from "@oxagen/billing";

const iam = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => iam);

import { createBillingStatementExportHandler } from "./billing.statement.export";
import { createBillingStatementGetHandler } from "./billing.statement.get";
import { makeCTX } from "./test-utils/fixtures";

const ORG = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
const NOW = new Date("2026-10-02T00:00:00.000Z");

const STATEMENT = {
  version: 1,
  reference: "ST-0192F3A4-20260901-20260930",
  generatedAt: NOW.toISOString(),
  provisional: false,
  org: { id: ORG, name: "Acme", slug: "acme" },
  period: {
    kind: "month",
    start: "2026-09-01T00:00:00.000Z",
    end: "2026-10-01T00:00:00.000Z",
    lastDay: "2026-09-30",
    label: "September 2026",
  },
  terms: {
    source: "published_tier",
    tier: "scale",
    agreementRef: null,
    currency: "usd",
    ratePerGauMicros: "5000",
    blockSizeGau: 10_000,
    includedGauPerMonth: 5_000,
    asOf: "2026-09-30T23:59:59.999Z",
  },
  agreements: [],
  governedActions: {
    totalUnits: 1,
    totalActions: 1,
    bySource: [],
    byWorkspace: { rows: [], other: { groups: 0, units: 0, actions: 0 } },
    byAgent: { rows: [], other: { groups: 0, units: 0, actions: 0 } },
    byOperator: { rows: [], other: { groups: 0, units: 0, actions: 0 } },
    bySubject: { rows: [], other: { groups: 0, units: 0, actions: 0 } },
    daily: [],
  },
  buckets: [],
  settlements: [],
  reversals: [],
  prepaidOrders: [],
  invoices: [],
  invoiceTotals: [],
  usageCredits: {
    openingCredits: "0",
    additions: [],
    deductions: [],
    closingCredits: "0",
    assistantCredits: "0",
    assistantByOperator: [],
    assistantUnattributedCredits: "0",
  },
  modelUsage: {
    rows: [],
    other: { groups: 0, calls: 0, inputTokens: 0, outputTokens: 0 },
    billedMicros: "0",
  },
  reconciliation: [],
} satisfies BillingStatement;

const ITEM: StatementLineItem = {
  id: "0192f3a4-0000-7000-8000-000000000001",
  billedAt: "2026-09-02T10:11:12.123456Z",
  occurredAt: "2026-09-02T10:11:11.000Z",
  source: "kernel",
  capability: "send_message",
  toolName: null,
  mcpServer: null,
  surface: "api",
  harness: null,
  workspaceId: null,
  workspace: null,
  agentId: null,
  agent: null,
  operatorUserId: null,
  operator: null,
  principalId: null,
  principalKind: null,
  runId: null,
  sessionId: null,
  toolCallId: null,
  requestId: "req_1",
  units: 1,
};

function deps() {
  return {
    build: vi.fn(async () => STATEMENT as BillingStatement),
    lineItems: vi.fn(async () => ({
      items: [ITEM],
      nextCursor: "next" as string | null,
    })),
    now: () => NOW,
  };
}

const ctx = (over: Parameters<typeof makeCTX>[0] = {}) =>
  makeCTX({ orgId: ORG, userId: "u_1", ...over });

beforeEach(() => {
  iam.assertOrgRole.mockReset().mockResolvedValue("Billing");
  iam.resolveActingUserId
    .mockReset()
    .mockImplementation(
      async (c: { userId: string | null }) => c.userId ?? "key_creator",
    );
});

async function refusal(p: Promise<unknown>): Promise<CapabilityError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CapabilityError);
  return err as CapabilityError;
}

describe("get_billing_statement handler", () => {
  it("gates on Owner, Admin or Billing for the acting user, then builds the period asked for", async () => {
    const d = deps();
    const out = await createBillingStatementGetHandler(d)(
      { period: "quarter", anchor: "2026-08-15", top: 10 },
      ctx(),
    );
    expect(out).toBe(STATEMENT);
    expect(iam.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, userId: "u_1" }),
      { org: ["Owner", "Admin", "Billing"] },
    );
    const [orgId, period, opts] = d.build.mock.calls[0] as unknown as [
      string,
      { start: Date; end: Date; label: string },
      unknown,
    ];
    expect(orgId).toBe(ORG);
    expect([
      period.start.toISOString(),
      period.end.toISOString(),
      period.label,
    ]).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
      "Q3 2026",
    ]);
    expect(opts).toEqual({ now: NOW, top: 10 });
  });

  it("acts as the API key's creator on a key call", async () => {
    await createBillingStatementGetHandler(deps())(
      { period: "month", anchor: "2026-09-01", top: 25 },
      ctx({ userId: null, apiKeyId: "key_1" }),
    );
    expect(iam.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "key_creator" }),
      expect.anything(),
    );
  });

  it("builds nothing when the role gate refuses", async () => {
    const d = deps();
    iam.assertOrgRole.mockRejectedValue(
      new HandlerError({ code: "forbidden", reason: "role_required" }),
    );
    await expect(
      createBillingStatementGetHandler(d)(
        { period: "month", anchor: "2026-09-01", top: 25 },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "forbidden", reason: "role_required" });
    expect(d.build).not.toHaveBeenCalled();
  });

  it("refuses a period it cannot state as invalid_input naming the rule", async () => {
    const d = deps();
    const err = await refusal(
      createBillingStatementGetHandler(d)(
        {
          period: "custom",
          from: "2026-09-01T00:00:00Z",
          to: "2026-09-02T00:00:00Z",
          top: 25,
        },
        ctx(),
      ),
    );
    expect(err.code).toBe("invalid_input");
    expect(err.message).toMatch(/^range_too_short: /);
    expect(d.build).not.toHaveBeenCalled();
    const missing = await refusal(
      createBillingStatementGetHandler(d)({ period: "week", top: 25 }, ctx()),
    );
    expect(missing.message).toMatch(/^anchor_required: /);
  });

  it("lets an unexpected failure through unchanged", async () => {
    const d = {
      ...deps(),
      build: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    await expect(
      createBillingStatementGetHandler(d)(
        { period: "month", anchor: "2026-09-01", top: 25 },
        ctx(),
      ),
    ).rejects.toThrow("db down");
  });
});

describe("export_billing_statement handler", () => {
  const month = { period: "month" as const, anchor: "2026-09-01", limit: 500 };

  it("answers the first CSV page with the header block, the rows and the next cursor", async () => {
    const d = deps();
    const out = await createBillingStatementExportHandler(d)(
      { ...month, format: "csv" },
      ctx(),
    );
    expect(out).toMatchObject({
      reference: "ST-0192F3A4-20260901-20260930",
      format: "csv",
      filename: "ST-0192F3A4-20260901-20260930.csv",
      mediaType: "text/csv",
      lines: 1,
      nextCursor: "next",
    });
    expect(
      out.content.startsWith(
        "Oxagen billing statement,ST-0192F3A4-20260901-20260930\r\n",
      ),
    ).toBe(true);
    expect(out.content).toContain("ledger_entry_id,billed_at");
    expect(d.lineItems).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ label: "September 2026" }),
      { cursor: null, limit: 500 },
    );
    expect(d.build).toHaveBeenCalledTimes(1);
  });

  it("answers a later page with rows only and does not rebuild the statement", async () => {
    const d = {
      ...deps(),
      lineItems: vi.fn(async () => ({ items: [ITEM], nextCursor: null })),
    };
    const out = await createBillingStatementExportHandler(d)(
      { ...month, format: "csv", cursor: "c1" },
      ctx(),
    );
    expect(
      out.content.startsWith("0192f3a4-0000-7000-8000-000000000001,"),
    ).toBe(true);
    expect(out.content).not.toContain("ledger_entry_id");
    expect(out.nextCursor).toBeNull();
    expect(d.build).not.toHaveBeenCalled();
    expect(d.lineItems).toHaveBeenCalledWith(ORG, expect.anything(), {
      cursor: "c1",
      limit: 500,
    });
  });

  it("refuses a cursor it did not write for this period", async () => {
    const d = {
      ...deps(),
      lineItems: vi.fn(async () => {
        throw new RangeError("invalid_cursor");
      }),
    };
    const err = await refusal(
      createBillingStatementExportHandler(d)(
        { ...month, format: "csv", cursor: "forged" },
        ctx(),
      ),
    );
    expect(err.code).toBe("invalid_input");
    expect(err.message).toMatch(/^invalid_cursor: /);
  });

  it("answers the HTML document whole, and refuses a cursor with it", async () => {
    const d = deps();
    const out = await createBillingStatementExportHandler(d)(
      { ...month, format: "html" },
      ctx(),
    );
    expect(out).toMatchObject({
      format: "html",
      filename: "ST-0192F3A4-20260901-20260930.html",
      mediaType: "text/html",
      lines: 0,
      nextCursor: null,
    });
    expect(out.content.startsWith("<!doctype html>")).toBe(true);
    expect(d.lineItems).not.toHaveBeenCalled();
    const err = await refusal(
      createBillingStatementExportHandler(d)(
        { ...month, format: "html", cursor: "c1" },
        ctx(),
      ),
    );
    expect(err.message).toMatch(/^cursor_not_paged: /);
  });

  it("gates before it reads anything", async () => {
    const d = deps();
    iam.assertOrgRole.mockRejectedValue(
      new HandlerError({ code: "forbidden", reason: "role_required" }),
    );
    await expect(
      createBillingStatementExportHandler(d)(
        { ...month, format: "csv" },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(d.lineItems).not.toHaveBeenCalled();
    expect(d.build).not.toHaveBeenCalled();
  });

  it("refuses a period that has not started", async () => {
    const err = await refusal(
      createBillingStatementExportHandler(deps())(
        { period: "year", anchor: "2027-03-01", limit: 10, format: "csv" },
        ctx(),
      ),
    );
    expect(err.message).toMatch(/^period_not_started: /);
  });
});
