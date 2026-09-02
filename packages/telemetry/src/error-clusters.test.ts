// error-clusters.test.ts
//
// Unit tests for clusterErrorEvents. The ClickHouse client is mocked so no
// live server is needed. We PIN the exact SQL shape (mocked CH happily
// accepts invalid SQL — memory: validate the query text, not just the JS
// return): GROUP BY stays `fingerprint` ONLY (never a bare aggregate alias),
// every other column goes through an aggregate, ORDER BY count DESC, the
// mandatory org_id + window filter, optional severity/source filters, LIMIT
// clamping, and the string→typed coercion.

import { afterEach, describe, expect, it, vi } from "vitest";

interface QueryCall {
  query: string;
  query_params: Record<string, unknown>;
  format?: string;
}

const queryMock =
  vi.fn<(args: QueryCall) => Promise<{ json: () => Promise<unknown[]> }>>();

vi.mock("./clickhouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clickhouse")>();
  return {
    ...actual,
    clickhouse: () => ({ query: queryMock }),
  };
});

import { clusterErrorEvents } from "./error-clusters";

const ORG = "11111111-1111-1111-1111-111111111111";

function mockCalls(clusterRows: unknown[], totalsRows: unknown[]): void {
  queryMock
    .mockImplementationOnce(async () => ({ json: async () => clusterRows }))
    .mockImplementationOnce(async () => ({ json: async () => totalsRows }));
}

function callAt(index: number): QueryCall {
  const call = queryMock.mock.calls[index]?.[0];
  if (!call) throw new Error(`clickhouse().query call ${index} was not made`);
  return call;
}

afterEach(() => {
  queryMock.mockReset();
});

describe("clusterErrorEvents", () => {
  it("groups strictly by fingerprint, aggregates every other column, and orders by count desc", async () => {
    mockCalls([], [{ total_errors: 0, distinct_clusters: 0 }]);
    await clusterErrorEvents({ orgId: ORG });

    const clusterQuery = callAt(0);
    expect(clusterQuery.query).toContain("FROM error_events");
    expect(clusterQuery.query).toContain("GROUP BY fingerprint");
    expect(clusterQuery.query).toContain("ORDER BY count DESC");
    expect(clusterQuery.query).toContain("LIMIT {limit:UInt32}");
    expect(clusterQuery.query).toContain("count() AS count");
    expect(clusterQuery.query).toContain(
      "argMax(error_class, created_at) AS error_class",
    );
    expect(clusterQuery.query).toContain(
      "argMax(message, created_at) AS sample_message",
    );
    expect(clusterQuery.query).toContain(
      "argMax(severity, created_at) AS severity",
    );
    expect(clusterQuery.query).toContain(
      "argMax(source, created_at) AS source",
    );
    expect(clusterQuery.query).toContain("min(created_at) AS first_seen");
    expect(clusterQuery.query).toContain("max(created_at) AS last_seen");
    expect(clusterQuery.query).toContain("org_id = {orgId:UUID}");
    expect(clusterQuery.query).toContain("created_at >= {since:DateTime64(3)}");
    expect(clusterQuery.format).toBe("JSONEachRow");
    expect(clusterQuery.query_params.orgId).toBe(ORG);
    expect(clusterQuery.query_params.limit).toBe(20);
    expect(String(clusterQuery.query_params.since)).not.toContain("Z");

    // Never a bare aggregate alias inside the GROUP BY clause itself.
    const groupByLine = clusterQuery.query
      .split("\n")
      .find((l) => l.trim().startsWith("GROUP BY"));
    expect(groupByLine?.trim()).toBe("GROUP BY fingerprint");
  });

  it("issues a second, non-grouped aggregate for totalErrors/distinctClusters over the same filters", async () => {
    mockCalls([], [{ total_errors: 42, distinct_clusters: 5 }]);
    await clusterErrorEvents({ orgId: ORG, severity: "error", source: "api" });

    const totalsQuery = callAt(1);
    expect(totalsQuery.query).toContain("count() AS total_errors");
    expect(totalsQuery.query).toContain(
      "uniqExact(fingerprint) AS distinct_clusters",
    );
    expect(totalsQuery.query).not.toContain("GROUP BY");
    expect(totalsQuery.query_params).toMatchObject({
      orgId: ORG,
      severity: "error",
      source: "api",
    });
  });

  it("adds severity/source filters only when supplied", async () => {
    mockCalls([], [{ total_errors: 0, distinct_clusters: 0 }]);
    await clusterErrorEvents({ orgId: ORG });
    expect(callAt(0).query).not.toContain("severity = {severity:String}");
    expect(callAt(0).query).not.toContain("source = {source:String}");

    mockCalls([], [{ total_errors: 0, distinct_clusters: 0 }]);
    await clusterErrorEvents({ orgId: ORG, severity: "fatal", source: "mcp" });
    expect(callAt(2).query).toContain("severity = {severity:String}");
    expect(callAt(2).query).toContain("source = {source:String}");
    expect(callAt(2).query_params).toMatchObject({
      severity: "fatal",
      source: "mcp",
    });
  });

  it("clamps limit to the 100 ceiling and floors sub-1 values to the default", async () => {
    mockCalls([], [{ total_errors: 0, distinct_clusters: 0 }]);
    await clusterErrorEvents({ orgId: ORG, limit: 100000 });
    expect(callAt(0).query_params.limit).toBe(100);

    mockCalls([], [{ total_errors: 0, distinct_clusters: 0 }]);
    await clusterErrorEvents({ orgId: ORG, limit: 0 });
    expect(callAt(2).query_params.limit).toBe(20);
  });

  it("coerces rows and returns totals from the second query", async () => {
    mockCalls(
      [
        {
          fingerprint: "fp1",
          error_class: "TypeError",
          sample_message: "cannot read properties of undefined",
          severity: "error",
          source: "api",
          count: "42",
          first_seen: "2026-07-05 00:00:00.000",
          last_seen: "2026-07-06 00:00:00.000",
        },
      ],
      [{ total_errors: "50", distinct_clusters: "3" }],
    );
    const out = await clusterErrorEvents({ orgId: ORG });
    expect(out.clusters).toEqual([
      {
        fingerprint: "fp1",
        errorClass: "TypeError",
        sampleMessage: "cannot read properties of undefined",
        severity: "error",
        source: "api",
        count: 42,
        firstSeen: "2026-07-05 00:00:00.000",
        lastSeen: "2026-07-06 00:00:00.000",
      },
    ]);
    expect(out.totalErrors).toBe(50);
    expect(out.distinctClusters).toBe(3);
  });

  it("defaults totals to zero when the totals query returns no row", async () => {
    mockCalls([], []);
    const out = await clusterErrorEvents({ orgId: ORG });
    expect(out.totalErrors).toBe(0);
    expect(out.distinctClusters).toBe(0);
    expect(out.clusters).toEqual([]);
  });
});
