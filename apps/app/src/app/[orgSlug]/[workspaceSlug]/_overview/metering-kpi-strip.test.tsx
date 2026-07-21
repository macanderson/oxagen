// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { BillingUsageBreakdownOutput } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import type { BillingSubscriptionReadOutput } from "@oxagen/oxagen/contracts/billing.subscription.read";

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

import { MeteringKpiStrip } from "./metering-kpi-strip";

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
    byUser: [],
    ...overrides,
  };
}

function subscription(
  overrides: Partial<BillingSubscriptionReadOutput> = {},
): BillingSubscriptionReadOutput {
  return {
    subscription: null,
    creditBalanceCents: 0,
    periodUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costMicros: 0,
      executions: 0,
    },
    ...overrides,
  };
}

function subscriptionRecord(
  overrides: Partial<
    NonNullable<BillingSubscriptionReadOutput["subscription"]>
  > = {},
): NonNullable<BillingSubscriptionReadOutput["subscription"]> {
  return {
    publicId: "sub_1",
    status: "active",
    planSlug: "pro",
    billingInterval: "month",
    currentPeriodStart: "2026-07-01T00:00:00.000Z",
    currentPeriodEnd: "2026-08-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    seatCount: 3,
    ...overrides,
  };
}

/** Route the shared mockInvoke by capability name, mirroring the strip's Promise.allSettled call. */
function invokeByCapability(handlers: Record<string, () => Promise<unknown>>) {
  mockInvoke.mockImplementation((name: string) => {
    const handler = handlers[name];
    if (!handler)
      return Promise.reject(new Error(`unexpected capability: ${name}`));
    return handler();
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MeteringKpiStrip", () => {
  it("renders the four KPI cards with formatted values on the happy path", async () => {
    mockAssertBillingManager.mockResolvedValue(undefined);
    invokeByCapability({
      get_usage_breakdown: () =>
        Promise.resolve(
          breakdown({
            totals: {
              inputTokens: 1000,
              outputTokens: 500,
              cachedTokens: 0,
              costMicros: 1_250_000,
              executions: 4,
              messages: 4,
            },
            series: [
              {
                day: "2026-07-10",
                inputTokens: 500,
                outputTokens: 250,
                cachedTokens: 0,
                costMicros: 600_000,
                executions: 2,
                messages: 2,
              },
              {
                day: "2026-07-11",
                inputTokens: 500,
                outputTokens: 250,
                cachedTokens: 0,
                costMicros: 650_000,
                executions: 2,
                messages: 2,
              },
            ],
          }),
        ),
      get_subscription: () =>
        Promise.resolve(
          subscription({
            subscription: subscriptionRecord({ planSlug: "pro" }),
            creditBalanceCents: 12345,
            periodUsage: {
              inputTokens: 1000,
              outputTokens: 500,
              cachedTokens: 0,
              costMicros: 1_250_000,
              executions: 4,
            },
          }),
        ),
    });

    const element = await MeteringKpiStrip(PROPS);
    render(element);

    expect(screen.getByTestId("overview-kpi-strip")).toBeInTheDocument();
    expect(screen.getByTestId("overview-kpi-spend")).toBeInTheDocument();
    expect(screen.getByTestId("overview-kpi-tokens")).toBeInTheDocument();
    expect(screen.getByTestId("overview-kpi-runs")).toBeInTheDocument();
    expect(screen.getByTestId("overview-kpi-credit")).toBeInTheDocument();

    expect(screen.getByText("$1.25")).toBeInTheDocument();
    expect(screen.getByText("$123.45")).toBeInTheDocument();
    expect(screen.getByText(/pro plan/i)).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument(); // agent runs value
  });

  it("renders a single denied card and never invokes usage queries for non-billing members", async () => {
    const denial = Object.assign(new Error("denied"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    mockAssertBillingManager.mockRejectedValue(denial);

    const element = await MeteringKpiStrip(PROPS);
    render(element);

    expect(screen.getByTestId("overview-kpi-denied")).toBeInTheDocument();
    expect(screen.getByText(/metering hidden/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view billing/i })).toHaveAttribute(
      "href",
      "/acme/billing/usage",
    );
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(screen.queryByTestId("overview-kpi-strip")).not.toBeInTheDocument();
  });

  it("still renders the strip with placeholders when one of the two reads fails", async () => {
    mockAssertBillingManager.mockResolvedValue(undefined);
    invokeByCapability({
      get_usage_breakdown: () =>
        Promise.reject(new Error("clickhouse unavailable")),
      get_subscription: () =>
        Promise.resolve(
          subscription({
            subscription: subscriptionRecord({ planSlug: "pro" }),
            creditBalanceCents: 5000,
          }),
        ),
    });

    const element = await MeteringKpiStrip(PROPS);
    render(element);

    expect(screen.getByTestId("overview-kpi-strip")).toBeInTheDocument();
    // Spend/tokens/runs cards fall back to "—" and "Unavailable" sub-text.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(0);
    // Credit balance still renders since get_subscription succeeded.
    expect(screen.getByText("$50.00")).toBeInTheDocument();
  });
});
