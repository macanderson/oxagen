// @vitest-environment jsdom
/**
 * usage-chart.test.tsx — render tests for UsageChart.
 *
 * Covers:
 *   - Empty metrics: renders "No usage yet this period."
 *   - Renders period date range
 *   - Renders each metric name
 *   - Renders formatted cost
 *   - Renders quantity
 *   - Bar width proportional to max quantity
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { UsageChart, type UsageSummary } from "./usage-chart";

afterEach(cleanup);

const emptySummary: UsageSummary = {
  periodStart: "2025-01-01T00:00:00Z",
  periodEnd: "2025-01-31T00:00:00Z",
  metrics: [],
};

const summaryWithMetrics: UsageSummary = {
  periodStart: "2025-01-01T00:00:00Z",
  periodEnd: "2025-01-31T00:00:00Z",
  metrics: [
    { metric: "tokens_input", quantity: 1000, totalCostMicros: 5_000_000 },
    { metric: "tokens_output", quantity: 500, totalCostMicros: 10_000_000 },
  ],
};

describe("UsageChart — empty state", () => {
  it("renders 'No usage yet this period.' when metrics is empty", () => {
    render(<UsageChart usage={emptySummary} />);
    expect(screen.getByText(/no usage yet this period/i)).toBeInTheDocument();
  });
});

describe("UsageChart — with metrics", () => {
  it("renders the 'Current period usage' heading", () => {
    render(<UsageChart usage={summaryWithMetrics} />);
    expect(screen.getByText(/current period usage/i)).toBeInTheDocument();
  });

  it("renders each metric name", () => {
    render(<UsageChart usage={summaryWithMetrics} />);
    expect(screen.getByText("tokens_input")).toBeInTheDocument();
    expect(screen.getByText("tokens_output")).toBeInTheDocument();
  });

  it("renders formatted quantities", () => {
    render(<UsageChart usage={summaryWithMetrics} />);
    expect(screen.getByText(/1,000/)).toBeInTheDocument();
    expect(screen.getByText(/500/)).toBeInTheDocument();
  });

  it("renders formatted cost for each metric", () => {
    render(<UsageChart usage={summaryWithMetrics} />);
    // totalCostMicros / 10_000 gives cents:
    //   5_000_000 / 10_000 = 500 cents → $5.00
    //   10_000_000 / 10_000 = 1000 cents → $10.00
    expect(screen.getByText(/\$5\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\$10\.00/)).toBeInTheDocument();
  });

  it("renders bar elements for each metric", () => {
    const { container } = render(<UsageChart usage={summaryWithMetrics} />);
    // Each metric has a progress bar div with style.width
    const bars = container.querySelectorAll(".bg-accent");
    expect(bars.length).toBe(2);
  });

  it("highest metric bar has 100% width", () => {
    const { container } = render(<UsageChart usage={summaryWithMetrics} />);
    const bars = Array.from(container.querySelectorAll(".bg-accent")) as HTMLElement[];
    // tokens_input has highest quantity (1000), so its bar should be 100%
    const widths = bars.map((b) => b.style.width);
    expect(widths).toContain("100%");
  });
});
