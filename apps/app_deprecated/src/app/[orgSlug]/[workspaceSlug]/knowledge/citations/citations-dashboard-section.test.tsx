// @vitest-environment jsdom
/**
 * citations-dashboard-section.test.tsx — render coverage for the async
 * CitationsDashboardSection Server Component.
 *
 * Like the other async RSC data-fetch wrappers in Knowledge → Memory
 * (memories-section.test.tsx, _sections/promotion-queue-section.test.tsx),
 * the section is just an async function returning JSX, so it's awaited
 * directly and the resolved element passed to render(). CitationsDashboard is
 * mocked to a stub (it has its own tests) so this file covers only the
 * section's own wiring: the get_citation_stats call succeeds and renders the
 * dashboard, and the fail-open ErrorState path when invoke throws.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const { mockInvoke, mockRunInTenantScope } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/_shared/components", () => ({
  ErrorState: ({ title }: { title?: string }) => (
    <div data-testid="error-state" data-title={title ?? ""} />
  ),
}));

vi.mock("@/components/knowledge/citations/citations-dashboard", () => ({
  CitationsDashboard: ({
    data,
    windowDays,
  }: {
    data: { totals: { citations: number } };
    windowDays: number;
  }) => (
    <div
      data-testid="citations-dashboard"
      data-citations={data.totals.citations}
      data-window-days={windowDays}
    />
  ),
}));

import { CitationsDashboardSection } from "./citations-dashboard-section";

afterEach(cleanup);
beforeEach(() => {
  mockInvoke.mockReset();
  mockRunInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
});

const BASE = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  orgSlug: "acme",
  workspaceSlug: "main",
  days: 30 as const,
};

describe("CitationsDashboardSection", () => {
  it("renders the dashboard with the fetched stats on success", async () => {
    mockInvoke.mockResolvedValue({
      totals: { citations: 12, executions: 4, memoriesCited: 3, nodesCited: 2 },
      byInfluence: {},
      byCompliance: {},
      daily: [],
      topMemories: [],
      leastUsefulMemories: [],
      mostViolatedRules: [],
      topNodes: [],
    });
    const element = await CitationsDashboardSection(BASE);
    render(element);

    const el = screen.getByTestId("citations-dashboard");
    expect(el).toHaveAttribute("data-citations", "12");
    expect(el).toHaveAttribute("data-window-days", "30");
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("renders ErrorState — not the dashboard — when the fetch fails", async () => {
    mockInvoke.mockRejectedValue(new Error("neo4j down"));
    const element = await CitationsDashboardSection(BASE);
    render(element);

    expect(screen.getByTestId("error-state")).toHaveAttribute(
      "data-title",
      "Couldn't load citation analytics",
    );
    expect(screen.queryByTestId("citations-dashboard")).toBeNull();
  });
});
