/**
 * Unit tests for billing-statement — the platform operator's statement.
 *
 * The run is exercised against fakes of the slug lookup, the tenant scope,
 * the builder, the ledger pages and the writer, so what is asserted is what
 * the operator gets: the org resolved by slug, the period resolved by
 * @oxagen/billing's own rules, every read inside the org's scope, and a CSV
 * written page by page with the header block once.
 */
import { describe, expect, it, vi } from "vitest";
import type { BillingStatement } from "@oxagen/oxagen/contracts/billing.statement.get";
import type { StatementLineItem } from "@oxagen/billing";
import {
  describeTarget,
  parseFlags,
  runBillingStatement,
} from "./billing-statement";

const ORG_ID = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const NOW = new Date("2026-10-02T00:00:00.000Z");

const STATEMENT: BillingStatement = {
  version: 1,
  reference: "ST-0192D4A8-20260901-20260930",
  generatedAt: NOW.toISOString(),
  provisional: false,
  org: { id: ORG_ID, name: "Acme", slug: "acme" },
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
    totalUnits: 2,
    totalActions: 2,
    bySource: [{ source: "kernel", units: 2, actions: 2 }],
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
  reconciliation: [
    { id: "units_by_day", statement: "The daily series adds up.", holds: true },
  ],
};

const item = (id: string): StatementLineItem => ({
  id,
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
  requestId: null,
  units: 1,
});

function deps() {
  const scopes: string[] = [];
  let inside = false;
  const chunks: { chunk: string; first: boolean }[] = [];
  return {
    scopes,
    chunks,
    d: {
      resolveOrgId: vi.fn(async (slug: string) =>
        slug === "acme" ? ORG_ID : null,
      ),
      inScope: async <T>(orgId: string, fn: () => Promise<T>) => {
        scopes.push(orgId);
        inside = true;
        try {
          return await fn();
        } finally {
          inside = false;
        }
      },
      build: vi.fn(async () => {
        expect(inside).toBe(true);
        return STATEMENT;
      }),
      lineItems: vi
        .fn()
        .mockImplementationOnce(async () => ({
          items: [item("a")],
          nextCursor: "c1",
        }))
        .mockImplementationOnce(async () => {
          expect(inside).toBe(true);
          return { items: [item("b")], nextCursor: null };
        }),
      write: vi.fn(async (chunk: string, first: boolean) => {
        chunks.push({ chunk, first });
      }),
      now: () => NOW,
    },
  };
}

describe("parseFlags", () => {
  it("reads the org, the period, the format and the file", () => {
    expect(
      parseFlags([
        "--org",
        "acme",
        "--period",
        "month",
        "--anchor",
        "2026-09-01",
        "--format",
        "csv",
        "--out",
        "s.csv",
      ]),
    ).toEqual({
      orgSlug: "acme",
      period: "month",
      anchor: "2026-09-01",
      from: undefined,
      to: undefined,
      format: "csv",
      out: "s.csv",
    });
    expect(
      parseFlags([
        "--org",
        "acme",
        "--period",
        "year",
        "--anchor",
        "2026-01-01",
      ]).format,
    ).toBe("html");
  });

  it("refuses an unknown flag, a missing value, a missing org and an unknown period or format", () => {
    expect(() =>
      parseFlags(["--org", "acme", "--period", "month", "--verbose", "x"]),
    ).toThrow(/unknown flag/);
    expect(() => parseFlags(["--org", "--period", "month"])).toThrow(
      /needs a value/,
    );
    expect(() => parseFlags(["--period", "month"])).toThrow(
      /--org is required/,
    );
    expect(() =>
      parseFlags(["--org", "acme", "--period", "fortnight"]),
    ).toThrow(/--period must be/);
    expect(() =>
      parseFlags(["--org", "acme", "--period", "month", "--format", "pdf"]),
    ).toThrow(/--format must be/);
  });
});

describe("runBillingStatement", () => {
  it("writes the CSV page by page inside the org's scope, the header block once", async () => {
    const { d, chunks, scopes } = deps();
    const run = await runBillingStatement(
      { orgSlug: "acme", period: "month", anchor: "2026-09-15", format: "csv" },
      d,
    );
    expect(run).toEqual({
      reference: STATEMENT.reference,
      rows: 2,
      checksHeld: true,
    });
    expect(scopes).toEqual([ORG_ID]);
    const [, period] = d.build.mock.calls[0] as unknown as [
      string,
      { start: Date; label: string },
    ];
    expect(period.start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(chunks.map((c) => c.first)).toEqual([true, false]);
    expect(
      chunks[0]?.chunk.startsWith(
        `Oxagen billing statement,${STATEMENT.reference}`,
      ),
    ).toBe(true);
    expect(chunks[1]?.chunk.startsWith("b,")).toBe(true);
    expect(d.lineItems).toHaveBeenNthCalledWith(2, ORG_ID, expect.anything(), {
      cursor: "c1",
      limit: 10_000,
    });
  });

  it("writes one HTML or JSON document", async () => {
    const html = deps();
    await runBillingStatement(
      {
        orgSlug: "acme",
        period: "month",
        anchor: "2026-09-15",
        format: "html",
      },
      html.d,
    );
    expect(html.chunks).toHaveLength(1);
    expect(html.chunks[0]?.chunk.startsWith("<!doctype html>")).toBe(true);
    expect(html.d.lineItems).not.toHaveBeenCalled();

    const json = deps();
    await runBillingStatement(
      {
        orgSlug: "acme",
        period: "month",
        anchor: "2026-09-15",
        format: "json",
      },
      json.d,
    );
    expect(JSON.parse(json.chunks[0]?.chunk ?? "{}").reference).toBe(
      STATEMENT.reference,
    );
  });

  it("refuses an unknown org and a period the statement cannot cover, before any read", async () => {
    const a = deps();
    await expect(
      runBillingStatement(
        {
          orgSlug: "nope",
          period: "month",
          anchor: "2026-09-01",
          format: "html",
        },
        a.d,
      ),
    ).rejects.toThrow(/no organisation with slug "nope"/);
    const b = deps();
    await expect(
      runBillingStatement(
        {
          orgSlug: "acme",
          period: "custom",
          from: "2026-09-01T00:00:00Z",
          to: "2026-09-02T00:00:00Z",
          format: "csv",
        },
        b.d,
      ),
    ).rejects.toThrow(/longer than 48 hours/);
    expect(b.d.build).not.toHaveBeenCalled();
  });
});

describe("describeTarget", () => {
  it("names the host and database and never the credentials", () => {
    expect(describeTarget("postgres://u:secret@db.example:6543/oxagen")).toBe(
      "db.example:6543/oxagen",
    );
    expect(describeTarget("not a url")).toBe("(unparseable DATABASE_URL)");
  });
});
