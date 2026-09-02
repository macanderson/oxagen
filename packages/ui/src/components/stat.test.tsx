// @vitest-environment jsdom
/**
 * stat.test.tsx — render tests for Stat + StatGroup.
 *
 * Covers: label/value/hint slots, trend arrow + derived intent, intent
 * override, tone, loading skeleton, StatGroup hairline framing and columns.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Stat, StatGroup } from "./stat";

afterEach(cleanup);

describe("Stat — render", () => {
  it("renders label, value, and hint", () => {
    render(<Stat label="Tool calls" value="48,391" hint="last 30 days" />);
    expect(screen.getByText("Tool calls")).toBeInTheDocument();
    expect(screen.getByText("48,391")).toBeInTheDocument();
    expect(screen.getByText("last 30 days")).toBeInTheDocument();
  });

  it("value uses tabular numerals", () => {
    render(<Stat label="Spend" value="$12.40" />);
    expect(screen.getByText("$12.40").className).toContain("tabular-nums");
  });

  it("up trend derives a positive (success) delta", () => {
    render(<Stat label="Runs" value="120" delta="+12%" trend="up" />);
    expect(screen.getByText("+12%").closest("span")?.className).toContain(
      "text-success",
    );
  });

  it("down trend derives a negative (error) delta", () => {
    render(<Stat label="Runs" value="90" delta="-8%" trend="down" />);
    expect(screen.getByText("-8%").closest("span")?.className).toContain(
      "text-error",
    );
  });

  it("intent override wins over trend direction (cost going up is bad)", () => {
    render(
      <Stat
        label="Spend"
        value="$99"
        delta="+40%"
        trend="up"
        intent="negative"
      />,
    );
    expect(screen.getByText("+40%").closest("span")?.className).toContain(
      "text-error",
    );
  });

  it("tone tints the value itself", () => {
    render(<Stat label="Open findings" value="3" tone="warning" />);
    expect(screen.getByText("3").className).toContain("text-warning");
  });

  it("loading renders a skeleton instead of the value", () => {
    const { container } = render(<Stat label="Spend" value="$1" loading />);
    expect(screen.queryByText("$1")).toBeNull();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });
});

describe("StatGroup — render", () => {
  it("frames children with hairline dividers via gap-px over the border color", () => {
    const { container } = render(
      <StatGroup>
        <Stat label="A" value="1" />
        <Stat label="B" value="2" />
      </StatGroup>,
    );
    const group = container.firstChild as HTMLElement;
    expect(group.className).toContain("gap-px");
    expect(group.className).toContain("bg-border");
  });

  it("derives lg column count from children (capped at 4)", () => {
    const { container } = render(
      <StatGroup>
        <Stat label="A" value="1" />
        <Stat label="B" value="2" />
        <Stat label="C" value="3" />
      </StatGroup>,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "lg:grid-cols-3",
    );
  });

  it("accepts an explicit column count", () => {
    const { container } = render(
      <StatGroup columns={2}>
        <Stat label="A" value="1" />
        <Stat label="B" value="2" />
        <Stat label="C" value="3" />
      </StatGroup>,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "lg:grid-cols-2",
    );
  });
});
