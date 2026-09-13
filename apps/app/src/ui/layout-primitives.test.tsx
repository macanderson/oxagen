// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import type { Route } from "next";
import { afterEach, describe, expect, it } from "vitest";
import { Meter, meterPercent } from "./meter";
import { PageHeader } from "./page-header";
import { RouteTabs } from "./route-tabs";
import { Sparkline, sparklinePaths } from "./sparkline";
import { renderWithIntl } from "./testing/render-with-intl";
import { Tile } from "./tile";

afterEach(() => {
  cleanup();
});

describe("RouteTabs", () => {
  const tabs = [
    {
      id: "registry",
      href: "/acme/core-platform/tools" as Route,
      label: "Registry",
    },
    {
      id: "connections",
      href: "/acme/core-platform/tools/connections" as Route,
      label: "Connections",
    },
    {
      id: "mandates",
      href: "/acme/core-platform/tools/mandates" as Route,
      label: "Mandates",
      count: 3,
    },
  ];

  it("renders each tab as a link to its segment and marks the current one", () => {
    renderWithIntl(
      <RouteTabs label="Tools sections" tabs={tabs} current="connections" />,
    );
    const nav = screen.getByRole("navigation", { name: "Tools sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/acme/core-platform/tools",
      "/acme/core-platform/tools/connections",
      "/acme/core-platform/tools/mandates",
    ]);
    expect(screen.getByRole("link", { name: "Connections" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Registry" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("shows a count after the label", () => {
    renderWithIntl(
      <RouteTabs label="Tools sections" tabs={tabs} current="registry" />,
    );
    expect(screen.getByTestId("route-tab-mandates")).toHaveTextContent(
      "Mandates3",
    );
  });

  it("marks nothing current for an unknown tab id", () => {
    renderWithIntl(
      <RouteTabs label="Tools sections" tabs={tabs} current="nope" />,
    );
    expect(screen.queryByRole("link", { current: "page" })).toBeNull();
  });
});

describe("PageHeader", () => {
  it("renders the page's one h1 with every slot", () => {
    renderWithIntl(
      <PageHeader
        title="Refetch a stable list"
        eyebrow="Run"
        description="Sealed 4 minutes ago."
        meta={<span>sealed</span>}
        actions={<button type="button">Export</button>}
        figure={<span>$4.13</span>}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Refetch a stable list" }),
    ).toBeVisible();
    for (const text of ["Run", "Sealed 4 minutes ago.", "sealed", "$4.13"])
      expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByRole("button", { name: "Export" })).toBeVisible();
  });

  it("renders only the title when nothing else is given", () => {
    const { container } = renderWithIntl(<PageHeader title="Fleet" />);
    expect(container.querySelectorAll("p")).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Tile", () => {
  it("is a named region with its label, value, context and chart", () => {
    renderWithIntl(
      <Tile
        label="Spend today"
        value="$412.00"
        sub="gateway_observed · USD"
        chart={<span>chart</span>}
      />,
    );
    const tile = screen.getByRole("region", { name: "Spend today" });
    expect(tile).toHaveTextContent(
      "Spend today$412.00gateway_observed · USDchart",
    );
  });

  it("omits the context and chart rows when not given", () => {
    renderWithIntl(<Tile label="Runs" value="12" />);
    expect(screen.getByTestId("tile").children).toHaveLength(2);
  });
});

describe("meterPercent", () => {
  it("computes a share of numbers", () => {
    expect(meterPercent(1, 3)).toBe(33.33);
    expect(meterPercent(5, 0)).toBe(0);
    expect(meterPercent(-1, 10)).toBe(0);
    expect(meterPercent(20, 10)).toBe(100);
  });

  it("computes a share of bigint micros without a float", () => {
    expect(meterPercent(9007199254740993n, 18014398509481986n)).toBe(50);
    expect(meterPercent(1n, 3n)).toBe(33.33);
    expect(meterPercent(250, 1000n)).toBe(25);
    expect(meterPercent(5n, 0)).toBe(0);
    expect(meterPercent(-5n, 10n)).toBe(0);
    expect(meterPercent(50n, 10n)).toBe(100);
  });
});

describe("Meter", () => {
  it("exposes the share as a meter with a readable value", () => {
    renderWithIntl(
      <Meter
        label="Marcus Bell"
        value={1204000000n}
        max={3000000000n}
        valueText="$1,204.00 · 40%"
        showText
      />,
    );
    const meter = screen.getByRole("meter", { name: "Marcus Bell" });
    expect(meter).toHaveAttribute("aria-valuenow", "40.13");
    expect(meter).toHaveAttribute("aria-valuetext", "$1,204.00 · 40%");
    expect(screen.getByText("$1,204.00 · 40%")).toBeVisible();
  });

  it("never draws an empty bar for a non-zero share, and draws none for zero", () => {
    renderWithIntl(
      <>
        <Meter label="tiny" value={1} max={100000} valueText="$0.00" />
        <Meter label="zero" value={0} max={100} valueText="$0.00" />
      </>,
    );
    const bar = (name: string) =>
      screen.getByRole("meter", { name }).firstElementChild as HTMLElement;
    expect(bar("tiny").style.width).toBe("1%");
    expect(bar("zero").style.width).toBe("0%");
    expect(screen.queryByText("tiny")).toBeNull();
  });
});

describe("sparklinePaths", () => {
  it("draws nothing for fewer than two points", () => {
    expect(sparklinePaths([], 100, 20)).toBeNull();
    expect(sparklinePaths([4], 100, 20)).toBeNull();
  });

  it("maps the maximum to the top and zero to the baseline", () => {
    const paths = sparklinePaths([0, 10], 106, 26, 3);
    expect(paths?.line).toBe("M3.0 23.0 L103.0 3.0");
    expect(paths?.area).toBe("M3.0 23.0 L103.0 3.0 L103.0 23.0 L3.0 23.0 Z");
  });

  it("keeps a flat series on the baseline and a negative one inside the box", () => {
    expect(sparklinePaths([0, 0, 0], 100, 20, 0)?.line).toBe(
      "M0.0 20.0 L50.0 20.0 L100.0 20.0",
    );
    expect(sparklinePaths([-10, 10n], 100, 20, 0)?.line).toBe(
      "M0.0 20.0 L100.0 0.0",
    );
  });
});

describe("Sparkline", () => {
  it("is one labelled image with a hover title per point", () => {
    renderWithIntl(
      <Sparkline
        points={[1, 3, 2]}
        label="Spend per day, last 3 days"
        pointLabels={["Sep 9 · $1", "Sep 10 · $3", "Sep 11 · $2"]}
      />,
    );
    const svg = screen.getByRole("img", { name: "Spend per day, last 3 days" });
    expect(svg.querySelectorAll("path")).toHaveLength(2);
    expect(
      [...svg.querySelectorAll("title")].map((t) => t.textContent),
    ).toEqual(["Sep 9 · $1", "Sep 10 · $3", "Sep 11 · $2"]);
  });

  it("renders an empty labelled frame for a single point", () => {
    renderWithIntl(<Sparkline points={[5]} label="One day" />);
    expect(
      screen.getByRole("img", { name: "One day" }).querySelectorAll("path"),
    ).toHaveLength(0);
  });
});
