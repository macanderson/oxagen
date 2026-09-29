// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  ChartContainer,
  ChartLegendContent,
  ChartTable,
  ChartTooltipContent,
  type ChartConfig,
} from "./chart";

// ResizeObserver stays unstubbed: recharts then keeps the initial size and
// renders the child, which is what these tests read.

afterEach(cleanup);

type TooltipEntry = NonNullable<
  ComponentProps<typeof ChartTooltipContent>["payload"]
>[number];
type LegendEntry = NonNullable<
  ComponentProps<typeof ChartLegendContent>["payload"]
>[number];

const CONFIG: ChartConfig = {
  done: { label: "Done", color: "var(--chart-1)" },
  failed: { label: "Failed", color: "var(--chart-2)" },
};

function inChart(child: ReactElement) {
  return render(
    <IntlProvider>
      <ChartContainer config={CONFIG} label="Runs by day">
        {child}
      </ChartContainer>
    </IntlProvider>,
  );
}

// A point with no value is a gap: the series was not recorded that day.
const point = (dataKey: string, value?: number): TooltipEntry => ({
  dataKey,
  value,
  color: `var(--color-${dataKey})`,
  payload: { day: "1 Sep" },
  graphicalItemId: dataKey,
});

function tooltipIn(container: HTMLElement): HTMLElement {
  const tooltip = container.querySelector<HTMLElement>(
    '[data-slot="chart-tooltip"]',
  );
  if (!tooltip) throw new Error("the tooltip did not draw");
  return tooltip;
}

describe("ChartContainer", () => {
  it("is a named image that carries each series colour", () => {
    inChart(<ChartLegendContent payload={[]} />);
    const chart = screen.getByRole("img", { name: "Runs by day" });
    expect(chart.style.getPropertyValue("--color-done")).toBe("var(--chart-1)");
    expect(chart.style.getPropertyValue("--color-failed")).toBe(
      "var(--chart-2)",
    );
  });
});

describe("ChartTooltipContent", () => {
  it("draws nothing while no point is hovered", () => {
    const view = inChart(
      <ChartTooltipContent
        active={false}
        payload={[point("done", 3)]}
      />,
    );
    expect(view.container.querySelector('[data-slot="chart-tooltip"]')).toBeNull();
  });

  it("names each series and marks a gap as not recorded", () => {
    const view = inChart(
      <ChartTooltipContent
        active
        label="1 Sep"
        payload={[point("done", 3), point("failed")]}
        formatValue={(value) => `${String(value)} runs`}
      />,
    );
    const tooltip = tooltipIn(view.container);
    expect(within(tooltip).getByText("1 Sep")).toBeTruthy();
    expect(within(tooltip).getByText("3 runs")).toBeTruthy();
    expect(within(tooltip).getByText("Done")).toBeTruthy();
    expect(within(tooltip).getByText("not recorded")).toBeTruthy();
    expect(within(tooltip).getByText("Failed")).toBeTruthy();
  });

  it("prints a lone series with no label beside it", () => {
    const view = inChart(
      <ChartTooltipContent
        active
        payload={[point("done", 1234.5)]}
      />,
    );
    const tooltip = tooltipIn(view.container);
    expect(within(tooltip).getByText("1,234.5")).toBeTruthy();
    expect(within(tooltip).queryByText("Done")).toBeNull();
  });
});

describe("ChartLegendContent", () => {
  const item = (dataKey: string): LegendEntry => ({
    dataKey,
    value: dataKey,
    color: `var(--color-${dataKey})`,
    type: "square",
  });

  it("draws nothing for a single series", () => {
    inChart(
      <ChartLegendContent payload={[item("done")]} />,
    );
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("lists each series by its configured label", () => {
    inChart(
      <ChartLegendContent
        payload={[item("done"), item("failed")]}
      />,
    );
    const legend = screen.getByRole("list");
    expect(within(legend).getByText("Done")).toBeTruthy();
    expect(within(legend).getByText("Failed")).toBeTruthy();
  });
});

describe("ChartTable", () => {
  it("puts every figure behind a disclosure, one header row", async () => {
    const view = render(
      <IntlProvider>
        <ChartTable
          label="Runs by day"
          columns={[{ label: "Day" }, { label: "Runs", numeric: true }]}
          rows={[
            { key: "a", cells: ["1 Sep", "3"] },
            { key: "b", cells: ["2 Sep", "5"] },
          ]}
        />
      </IntlProvider>,
    );
    expect(view.container.querySelector("summary")?.textContent).toBe("Table");
    const table = screen.getByRole("table", {
      name: "Runs by day",
      hidden: true,
    });
    const rows = within(table).getAllByRole("row", { hidden: true });
    expect(rows).toHaveLength(3);
    const last = rows.at(2);
    if (!last) throw new Error("the table lost a row");
    expect(
      within(last).getByRole("rowheader", { name: "2 Sep", hidden: true }),
    ).toBeTruthy();
    expect(within(last).getByText("5").className).toContain("text-right");
    await expectNoAxe(view.container);
  });
});
