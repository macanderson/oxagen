// @vitest-environment jsdom
/**
 * loading-skeletons.test.tsx — render tests for the loading skeleton primitives.
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { LoadingRegion } from "./loading-region";
import { PageHeaderSkeleton } from "./page-header-skeleton";
import { TableSkeleton } from "./table-skeleton";
import { CardGridSkeleton } from "./card-grid-skeleton";
import { StatCardsSkeleton } from "./stat-cards-skeleton";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// LoadingRegion
// ---------------------------------------------------------------------------
describe("LoadingRegion", () => {
  it("renders role=status", () => {
    const { getByRole } = render(
      <LoadingRegion label="Loading content">
        <span>child</span>
      </LoadingRegion>,
    );
    expect(getByRole("status")).toBeInTheDocument();
  });

  it("sets aria-busy=true", () => {
    const { getByRole } = render(
      <LoadingRegion label="Loading content">
        <span>child</span>
      </LoadingRegion>,
    );
    expect(getByRole("status")).toHaveAttribute("aria-busy", "true");
  });

  it("sets aria-label from the label prop", () => {
    const { getByRole } = render(
      <LoadingRegion label="Loading users">
        <span>child</span>
      </LoadingRegion>,
    );
    expect(getByRole("status")).toHaveAttribute("aria-label", "Loading users");
  });

  it("renders children inside the wrapper", () => {
    const { getByText } = render(
      <LoadingRegion label="Loading">
        <span>inner content</span>
      </LoadingRegion>,
    );
    expect(getByText("inner content")).toBeInTheDocument();
  });

  it("merges custom className", () => {
    const { getByRole } = render(
      <LoadingRegion label="Loading" className="my-custom-class">
        <span />
      </LoadingRegion>,
    );
    expect(getByRole("status").className).toContain("my-custom-class");
  });
});

// ---------------------------------------------------------------------------
// PageHeaderSkeleton
// ---------------------------------------------------------------------------

// Skeleton renders a div with class "animate-pulse" — use that as the selector.
const skeletonSel = ".animate-pulse";

describe("PageHeaderSkeleton", () => {
  it("does not render the action placeholder by default (3 skeletons)", () => {
    const { container } = render(<PageHeaderSkeleton />);
    expect(container.querySelectorAll(skeletonSel)).toHaveLength(3);
  });

  it("renders the action placeholder when withAction is true (4 skeletons)", () => {
    const { container } = render(<PageHeaderSkeleton withAction />);
    expect(container.querySelectorAll(skeletonSel)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// TableSkeleton
// ---------------------------------------------------------------------------
describe("TableSkeleton", () => {
  it("renders the correct number of header cells", () => {
    const { container } = render(<TableSkeleton rows={3} cols={5} />);
    // The header row is the first child of the outer wrapper
    const outerDiv = container.firstElementChild!;
    const headerRow = outerDiv.children[0];
    expect(headerRow.querySelectorAll(skeletonSel)).toHaveLength(5);
  });

  it("renders the requested number of body rows", () => {
    const { container } = render(<TableSkeleton rows={7} cols={3} />);
    const outerDiv = container.firstElementChild!;
    // first child = header row, remaining = body rows
    const bodyRows = Array.from(outerDiv.children).slice(1);
    expect(bodyRows).toHaveLength(7);
  });

  it("renders cols skeleton cells per body row", () => {
    const { container } = render(<TableSkeleton rows={2} cols={6} />);
    const outerDiv = container.firstElementChild!;
    const firstBodyRow = outerDiv.children[1];
    expect(firstBodyRow.querySelectorAll(skeletonSel)).toHaveLength(6);
  });

  it("defaults to 5 rows and 4 cols", () => {
    const { container } = render(<TableSkeleton />);
    const outerDiv = container.firstElementChild!;
    // 1 header row + 5 body rows = 6 total children
    expect(outerDiv.children).toHaveLength(6);
    // header has 4 skeletons
    expect(outerDiv.children[0].querySelectorAll(skeletonSel)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// CardGridSkeleton
// ---------------------------------------------------------------------------
describe("CardGridSkeleton", () => {
  it("renders the requested count of card containers", () => {
    const { container } = render(<CardGridSkeleton count={6} />);
    expect(container.firstElementChild!.children).toHaveLength(6);
  });

  it("defaults to 3 cards", () => {
    const { container } = render(<CardGridSkeleton />);
    expect(container.firstElementChild!.children).toHaveLength(3);
  });

  it("each card contains 3 skeleton elements", () => {
    const { container } = render(<CardGridSkeleton count={2} />);
    for (const card of Array.from(container.firstElementChild!.children)) {
      expect(card.querySelectorAll(skeletonSel)).toHaveLength(3);
    }
  });
});

// ---------------------------------------------------------------------------
// StatCardsSkeleton
// ---------------------------------------------------------------------------
describe("StatCardsSkeleton", () => {
  it("renders the requested count of stat cards", () => {
    const { container } = render(<StatCardsSkeleton count={8} />);
    expect(container.firstElementChild!.children).toHaveLength(8);
  });

  it("defaults to 4 cards", () => {
    const { container } = render(<StatCardsSkeleton />);
    expect(container.firstElementChild!.children).toHaveLength(4);
  });

  it("each card contains 2 skeleton elements", () => {
    const { container } = render(<StatCardsSkeleton count={3} />);
    for (const card of Array.from(container.firstElementChild!.children)) {
      expect(card.querySelectorAll(skeletonSel)).toHaveLength(2);
    }
  });
});
