// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { BillingUsageBreakdownOutput } from "@oxagen/oxagen/contracts/billing.usage.breakdown";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
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
vi.mock("@/lib/resolve-org", () => ({ assertBillingManager: mockAssertBillingManager }));

import { SpendTile } from "./spend-section";

const PROPS = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  orgSlug: "acme",
  workspaceSlug: "prod",
};

function breakdown(overrides: Partial<BillingUsageBreakdownOutput> = {}): BillingUsageBreakdownOutput {
  return {
    range: { start: "", end: "" },
    totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costMicros: 0, executions: 0 },
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

describe("SpendTile", () => {
  it("renders current-period cost and a sparkline when data is present", async () => {
    mockAssertBillingManager.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue(
      breakdown({
        totals: { inputTokens: 100, outputTokens: 50, cachedTokens: 0, costMicros: 1_250_000, executions: 4 },
        series: [
          { day: "2026-07-10", inputTokens: 10, outputTokens: 5, cachedTokens: 0, costMicros: 500_000, executions: 1 },
          { day: "2026-07-11", inputTokens: 20, outputTokens: 10, cachedTokens: 0, costMicros: 750_000, executions: 3 },
        ],
      }),
    );

    const element = await SpendTile(PROPS);
    render(element);

    expect(screen.getByTestId("overview-spend-tile")).toBeInTheDocument();
    expect(screen.getByText("$1.25")).toBeInTheDocument();
    expect(screen.getByText(/4 llm calls/i)).toBeInTheDocument();
    expect(screen.getByTestId("overview-spend-sparkline")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view billing/i })).toHaveAttribute(
      "href",
      "/acme/billing/usage",
    );
  });

  it("renders a zero-state inviting the first Ask for a brand-new workspace", async () => {
    mockAssertBillingManager.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue(breakdown());

    const element = await SpendTile(PROPS);
    render(element);

    expect(screen.getByText(/no spend yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open ask/i })).toHaveAttribute(
      "href",
      "/acme/prod/ask",
    );
  });

  it("renders a degraded no-access state and never invokes the usage query for non-billing members", async () => {
    const denial = Object.assign(new Error("denied"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    mockAssertBillingManager.mockRejectedValue(denial);

    const element = await SpendTile(PROPS);
    render(element);

    expect(screen.getByText(/spend visibility requires billing access/i)).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("renders a degraded error state when the usage query fails", async () => {
    mockAssertBillingManager.mockResolvedValue(undefined);
    mockInvoke.mockRejectedValue(new Error("clickhouse unavailable"));

    const element = await SpendTile(PROPS);
    render(element);

    expect(screen.getByText(/spend unavailable/i)).toBeInTheDocument();
  });
});
