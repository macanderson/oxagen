// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { BillingUsageBreakdownOutput } from "@oxagen/oxagen/contracts/billing.usage.breakdown";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@oxagen/handlers/register", () => ({}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: vi.fn(async (_scope: unknown, fn: () => unknown) => fn()),
}));

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));

const { mockAssertBillingManager } = vi.hoisted(() => ({
  mockAssertBillingManager: vi.fn(),
}));
vi.mock("@/lib/resolve-org", () => ({
  assertBillingManager: mockAssertBillingManager,
}));

// usage-panel-charts.tsx is a "use client" wrapper around dynamic(..., { ssr: false })
// reaviz charts — stub it out so the panel test stays focused on data-shape logic,
// same rationale as the exemplar tests stubbing next/link.
vi.mock("./usage-panel-charts", () => ({
  UsagePanelCharts: () => <div data-testid="stub-usage-panel-charts" />,
}));

import { UsagePanel } from "./usage-panel";

const PROPS = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  orgSlug: "acme",
  workspaceSlug: "prod",
};

function breakdown(
  overrides: Partial<BillingUsageBreakdownOutput> = {},
): BillingUsageBreakdownOutput {
  return {
    range: { start: "", end: "" },
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costMicros: 0,
      executions: 0,
      messages: 0,
    },
    series: [],
    byModel: [],
    bySurface: [],
    byWorkspace: [],
    byCapability: [],
    byPrincipal: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UsagePanel", () => {
  it("renders month-to-date cost and the charts when data is present", async () => {
    mockAssertBillingManager.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue(
      breakdown({
        totals: {
          inputTokens: 100,
          outputTokens: 50,
          cachedTokens: 0,
          costMicros: 1_250_000,
          executions: 4,
          messages: 4,
        },
        series: [
          {
            day: "2026-07-10",
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: 0,
            costMicros: 500_000,
            executions: 1,
            messages: 1,
          },
        ],
        byModel: [
          {
            key: "gpt-5",
            provider: "openai",
            inputTokens: 100,
            outputTokens: 50,
            cachedTokens: 0,
            costMicros: 1_250_000,
            executions: 4,
            messages: 4,
          },
        ],
      }),
    );

    const element = await UsagePanel(PROPS);
    render(element);

    expect(screen.getByTestId("overview-usage-panel")).toBeInTheDocument();
    expect(screen.getByText("$1.25")).toBeInTheDocument();
    expect(screen.getByText(/4 llm calls/i)).toBeInTheDocument();
    expect(screen.getByTestId("stub-usage-panel-charts")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /full breakdown/i }),
    ).toHaveAttribute("href", "/acme/billing/usage");
  });

  it("renders a zero-state when there is no usage yet", async () => {
    mockAssertBillingManager.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue(breakdown());

    const element = await UsagePanel(PROPS);
    render(element);

    expect(screen.getByText(/no usage yet/i)).toBeInTheDocument();
  });

  it("renders a degraded no-access state and never invokes the usage query for non-billing members", async () => {
    const denial = Object.assign(new Error("denied"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    mockAssertBillingManager.mockRejectedValue(denial);

    const element = await UsagePanel(PROPS);
    render(element);

    expect(screen.getByText(/usage hidden/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view billing/i })).toHaveAttribute(
      "href",
      "/acme/billing/usage",
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("renders a degraded error state when the usage query fails", async () => {
    mockAssertBillingManager.mockResolvedValue(undefined);
    mockInvoke.mockRejectedValue(new Error("clickhouse unavailable"));

    const element = await UsagePanel(PROPS);
    render(element);

    expect(screen.getByText(/usage unavailable/i)).toBeInTheDocument();
  });
});
