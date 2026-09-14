// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

vi.mock("@/components/loading", () => ({
  LoadingRegion: ({
    children,
    label,
  }: {
    children: React.ReactNode;
    label: string;
  }) => <div aria-label={label}>{children}</div>,
  DetailSkeleton: () => <div data-testid="detail-skeleton" />,
  CardGridSkeleton: ({ count }: { count: number }) => (
    <div data-testid="card-grid-skeleton" data-count={count} />
  ),
}));

import { BillingSubscriptionSkeleton } from "./subscription-skeleton";

describe("BillingSubscriptionSkeleton", () => {
  it("renders without crashing", () => {
    const { container } = render(<BillingSubscriptionSkeleton />);
    expect(container.firstChild).toBeDefined();
  });

  it("has aria-label 'Loading billing' from LoadingRegion", () => {
    render(<BillingSubscriptionSkeleton />);
    expect(screen.getByLabelText("Loading billing")).toBeDefined();
  });

  it("renders multiple DetailSkeleton components", () => {
    render(<BillingSubscriptionSkeleton />);
    const skeletons = screen.getAllByTestId("detail-skeleton");
    expect(skeletons.length).toBeGreaterThanOrEqual(2);
  });

  it("renders CardGridSkeleton with count=3 for the plan cards", () => {
    render(<BillingSubscriptionSkeleton />);
    const grids = screen.getAllByTestId("card-grid-skeleton");
    // One with count=1 (credit sidebar) and one with count=3 (plan cards)
    const planGrid = grids.find((el) => el.getAttribute("data-count") === "3");
    expect(planGrid).toBeDefined();
  });
});
