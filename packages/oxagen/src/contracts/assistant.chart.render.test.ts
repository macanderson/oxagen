import { describe, expect, it } from "vitest";
import { CHART_LIMITS } from "../chart-spec";
import { assistantChartRender } from "./assistant.chart.render";

const SPEND = {
  source: "get_spend, 1-7 September",
  charts: [
    {
      title: "Spend by day",
      kind: "line",
      series: [{ label: "Spend" }],
      rows: [
        { label: "1 Sep", values: [12.5] },
        { label: "2 Sep", values: [null] },
      ],
      format: { kind: "currency", currency: "USD" },
    },
  ],
};

const issues = (input: unknown) => {
  const parsed = assistantChartRender.input.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."));
};

describe("render_chart contract", () => {
  it("is an agent-surface tool that reads nothing and spends nothing", () => {
    expect(assistantChartRender.surfaces).toEqual(["agent"]);
    expect(assistantChartRender.domain).toBe("assistant");
    expect(assistantChartRender.mutates).toBe(false);
    expect(assistantChartRender.noBillingGate).toBe(true);
    expect(assistantChartRender.agent).toEqual({
      requiresApproval: false,
      riskLevel: "low",
      category: "read",
    });
    expect(assistantChartRender.layers).toContain("app");
  });

  it("names the words search_tools matches on", () => {
    for (const word of ["chart", "graph", "plot", "dashboard", "tiles"]) {
      expect(assistantChartRender.description).toContain(word);
    }
  });

  it("accepts a chart with a gap and defaults the missing list to empty", () => {
    const parsed = assistantChartRender.input.parse(SPEND);
    expect(parsed.tiles).toEqual([]);
    expect(parsed.charts[0]?.rows[1]?.values).toEqual([null]);
  });

  it("accepts tiles alone", () => {
    expect(
      issues({
        source: "list_runs, today",
        tiles: [{ label: "Runs", value: 42 }],
      }),
    ).toEqual([]);
  });

  it("refuses a request with no chart and no tile (negative)", () => {
    expect(issues({ source: "get_spend" })).toEqual(["charts"]);
  });

  it("refuses a missing source (negative)", () => {
    const { source: _source, ...rest } = SPEND;
    expect(issues(rest)).toContain("source");
  });

  it("refuses a row whose value count differs from the series count (negative)", () => {
    const chart = SPEND.charts[0]!;
    expect(
      issues({
        ...SPEND,
        charts: [
          {
            ...chart,
            series: [{ label: "Spend" }, { label: "Budget" }],
          },
        ],
      }),
    ).toEqual(["charts.0.rows.0.values", "charts.0.rows.1.values"]);
  });

  it("refuses a currency format with no code, on a chart and on a tile (negative)", () => {
    const chart = SPEND.charts[0]!;
    expect(
      issues({
        ...SPEND,
        tiles: [{ label: "Total", value: 3, format: { kind: "currency" } }],
        charts: [{ ...chart, format: { kind: "currency" } }],
      }),
    ).toEqual(["tiles.0.format.currency", "charts.0.format.currency"]);
  });

  it("refuses an infinite value and a sixth series (negative)", () => {
    const chart = SPEND.charts[0]!;
    expect(
      issues({
        ...SPEND,
        charts: [{ ...chart, rows: [{ label: "1 Sep", values: [Infinity] }] }],
      }),
    ).toContain("charts.0.rows.0.values.0");
    const series = Array.from({ length: CHART_LIMITS.series + 1 }, (_, i) => ({
      label: `S${i}`,
    }));
    expect(issues({ ...SPEND, charts: [{ ...chart, series }] })).toContain(
      "charts.0.series",
    );
  });

  it("refuses more rows and charts than the limits hold (negative)", () => {
    const chart = SPEND.charts[0]!;
    const rows = Array.from({ length: CHART_LIMITS.rows + 1 }, (_, i) => ({
      label: `Day ${i}`,
      values: [i],
    }));
    expect(issues({ ...SPEND, charts: [{ ...chart, rows }] })).toContain(
      "charts.0.rows",
    );
    const charts = Array.from({ length: CHART_LIMITS.charts + 1 }, () => chart);
    expect(issues({ ...SPEND, charts })).toContain("charts");
  });
});
