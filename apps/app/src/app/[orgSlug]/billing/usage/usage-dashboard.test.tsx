// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

vi.mock("reaviz", () => ({
  AreaChart: () => <div data-testid="area-chart" />,
  AreaSeries: () => null,
  LinearXAxis: () => null,
  LinearXAxisTickSeries: () => null,
  LinearXAxisTickLabel: () => null,
  LinearYAxis: () => null,
  LinearYAxisTickSeries: () => null,
  GridlineSeries: () => null,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  CardPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/panel", () => ({
  Panel: ({ children, title }: { children: React.ReactNode; title?: string }) => (
    <div>
      {title ? <h2>{title}</h2> : null}
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/lib/utils", () => ({
  formatCents: (cents: number) => `$${(cents / 100).toFixed(2)}`,
}));

import { UsageDashboard } from "./usage-dashboard";

describe("UsageDashboard", () => {
  it("renders 'Credits spent' stat card", () => {
    render(<UsageDashboard />);
    expect(screen.getByText("Credits spent")).toBeDefined();
  });

  it("renders 'Total tokens' stat card", () => {
    render(<UsageDashboard />);
    expect(screen.getByText("Total tokens")).toBeDefined();
  });

  it("renders 'API + MCP calls' stat card", () => {
    render(<UsageDashboard />);
    expect(screen.getByText("API + MCP calls")).toBeDefined();
  });

  it("renders 'Active workspaces' stat card", () => {
    render(<UsageDashboard />);
    expect(screen.getByText("Active workspaces")).toBeDefined();
  });

  it("renders the area chart", () => {
    render(<UsageDashboard />);
    expect(screen.getByTestId("area-chart")).toBeDefined();
  });

  it("renders the Preview pill", () => {
    render(<UsageDashboard />);
    expect(screen.getByText(/Preview/)).toBeDefined();
  });

  it("renders the model breakdown table with at least one row", () => {
    render(<UsageDashboard />);
    // The component renders a per-model table; verify at least one known model name appears
    expect(screen.getByText("claude-sonnet-4-5")).toBeDefined();
  });

  it("renders workspace breakdown table rows", () => {
    render(<UsageDashboard />);
    // WORKSPACE_ROWS includes "production" and "engineering"
    expect(screen.getByText("production")).toBeDefined();
    expect(screen.getByText("engineering")).toBeDefined();
  });
});
