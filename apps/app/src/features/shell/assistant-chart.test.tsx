// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CHART_LIMITS } from "@oxagen/oxagen/chart-spec";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { AssistantChartBlock } from "./assistant-chart";

// ResizeObserver stays unstubbed on purpose: recharts' ResponsiveContainer
// then keeps its initial size, so the chart draws in jsdom. These tests read
// the figure, the tiles, and the table, never the SVG's geometry.

afterEach(cleanup);

const DASHBOARD = {
  title: "September spend",
  source: "get_spend, 1-3 September",
  tiles: [
    {
      label: "Total",
      value: 42.5,
      format: { kind: "currency", currency: "USD" },
      note: "Three days",
    },
    { label: "Cache hits", value: 0.25, format: { kind: "percent" } },
    { label: "Slowest run", value: null },
  ],
  charts: [
    {
      title: "Spend by day",
      kind: "line",
      series: [{ label: "Spend" }],
      rows: [
        { label: "1 Sep", values: [12.5] },
        { label: "2 Sep", values: [null] },
        { label: "3 Sep", values: [30] },
      ],
      format: { kind: "currency", currency: "USD" },
    },
    {
      title: "Runs by agent",
      kind: "bar",
      series: [{ label: "Runs" }],
      rows: [
        { label: "Reviewer", values: [12] },
        { label: "Planner", values: [4] },
      ],
      format: { kind: "number" },
      unit: "runs",
    },
  ],
};

function draw(spec: unknown, isIncomplete = false) {
  const code = typeof spec === "string" ? spec : JSON.stringify(spec);
  return render(
    <IntlProvider>
      <AssistantChartBlock code={code} isIncomplete={isIncomplete} />
    </IntlProvider>,
  );
}

const oneChart = (chart: Record<string, unknown>) => ({
  source: "list_runs, today",
  charts: [
    {
      title: "Chart",
      kind: "bar",
      series: [{ label: "Value" }],
      rows: [{ label: "A", values: [1] }],
      format: { kind: "number" },
      ...chart,
    },
  ],
});

describe("AssistantChartBlock", () => {
  it("draws the dashboard: title, tiles, charts, tables, and source", async () => {
    const view = draw(DASHBOARD);
    const figure = screen.getByTestId("assistant-chart");
    expect(within(figure).getByText("September spend")).toBeTruthy();
    expect(within(figure).getByText("$42.50")).toBeTruthy();
    expect(within(figure).getByText("Three days")).toBeTruthy();
    expect(within(figure).getByText("25%")).toBeTruthy();
    expect(
      within(figure).getByText("Source: get_spend, 1-3 September"),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: "Spend by day" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Runs by agent" })).toBeTruthy();
    await expectNoAxe(view.container);
  });

  it("prints every value in the table, with a gap as not recorded", () => {
    draw(DASHBOARD);
    const table = screen.getByRole("table", {
      name: "Spend by day",
      hidden: true,
    });
    const rows = within(table).getAllByRole("row", { hidden: true });
    expect(rows).toHaveLength(4);
    expect(within(rows[1]!).getByText("$12.50")).toBeTruthy();
    expect(within(rows[2]!).getByText("not recorded")).toBeTruthy();
    expect(within(rows[3]!).getByText("$30.00")).toBeTruthy();
  });

  it("marks a null tile as not recorded rather than zero", () => {
    draw(DASHBOARD);
    const tile = screen.getByText("Slowest run").parentElement!;
    expect(within(tile).getByText("not recorded")).toBeTruthy();
    expect(within(tile).queryByText("0")).toBeNull();
  });

  it("adds the unit to a plain number", () => {
    draw(DASHBOARD);
    const table = screen.getByRole("table", {
      name: "Runs by agent",
      hidden: true,
    });
    expect(within(table).getByText("12 runs")).toBeTruthy();
  });

  it("formats a duration in milliseconds", () => {
    draw({
      source: "list_runs, today",
      tiles: [{ label: "Build", value: 1500, format: { kind: "duration" } }],
    });
    expect(screen.getByText("1.5 s")).toBeTruthy();
  });

  it.each([
    ["line", 3],
    ["area", 3],
    ["bar", 3],
    ["bar", CHART_LIMITS.rows],
    ["stacked_bar", 3],
  ])("draws a %s chart with %i rows", (kind, rowCount) => {
    draw(
      oneChart({
        kind,
        title: `A ${kind} chart`,
        series: [{ label: "Done" }, { label: "Failed" }],
        rows: Array.from({ length: rowCount }, (_, i) => ({
          label: `Row ${i}`,
          values: [i, i === 0 ? null : 1],
        })),
      }),
    );
    expect(screen.getByRole("img", { name: `A ${kind} chart` })).toBeTruthy();
    const table = screen.getByRole("table", {
      name: `A ${kind} chart`,
      hidden: true,
    });
    expect(within(table).getAllByRole("row", { hidden: true })).toHaveLength(
      rowCount + 1,
    );
    expect(
      within(table).getByRole("columnheader", { name: "Failed", hidden: true }),
    ).toBeTruthy();
  });

  it("draws tiles alone with no chart", () => {
    draw({ source: "list_runs, today", tiles: [{ label: "Runs", value: 7 }] });
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows a placeholder while the reply is still streaming", () => {
    draw('{"source": "get_sp', true);
    expect(screen.getByTestId("assistant-chart-drawing").textContent).toBe(
      "Drawing the chart…",
    );
    expect(screen.queryByTestId("assistant-chart")).toBeNull();
  });

  it.each([
    ["broken JSON", '{"source": '],
    ["an empty block", "   "],
    ["a spec with no chart and no tile", JSON.stringify({ source: "x" })],
    [
      "a row whose value count differs from the series count",
      JSON.stringify(
        oneChart({ series: [{ label: "A" }, { label: "B" }] }),
      ),
    ],
    [
      "a currency format with no code",
      JSON.stringify(oneChart({ format: { kind: "currency" } })),
    ],
    [
      "a block over the byte limit",
      JSON.stringify({ source: "x".repeat(CHART_LIMITS.bytes + 1) }),
    ],
  ])("prints %s as code (negative)", (_, code) => {
    draw(code);
    const fallback = screen.getByTestId("assistant-chart-unreadable");
    expect(
      within(fallback).getByText(
        "This chart could not be read, so its block prints as sent.",
      ),
    ).toBeTruthy();
    expect(fallback.querySelector("code")?.textContent).toBe(code);
    expect(screen.queryByTestId("assistant-chart")).toBeNull();
  });
});
