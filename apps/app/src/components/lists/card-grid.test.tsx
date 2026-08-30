// @vitest-environment jsdom
/**
 * card-grid.test.tsx — smoke tests for CardGrid.
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { CardGrid } from "./card-grid";

afterEach(cleanup);

describe("CardGrid — render", () => {
  it("renders its children", () => {
    const { getByText } = render(
      <CardGrid>
        <div>Card A</div>
        <div>Card B</div>
      </CardGrid>,
    );
    expect(getByText("Card A")).toBeInTheDocument();
    expect(getByText("Card B")).toBeInTheDocument();
  });

  it("applies the responsive grid classes by default", () => {
    const { container } = render(<CardGrid>Content</CardGrid>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("grid-cols-1");
    expect(el.className).toContain("sm:grid-cols-2");
    expect(el.className).toContain("xl:grid-cols-3");
  });

  it("merges a caller-supplied className", () => {
    const { container } = render(
      <CardGrid className="custom-grid">Content</CardGrid>,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "custom-grid",
    );
  });

  it("lets a caller override the column count via className", () => {
    const { container } = render(
      <CardGrid className="grid-cols-2">Content</CardGrid>,
    );
    const el = container.firstChild as HTMLElement;
    // tailwind-merge resolves the conflicting grid-cols-* utility in favor of
    // the caller-supplied class.
    expect(el.className).toContain("grid-cols-2");
    expect(el.className).not.toContain("grid-cols-1");
  });

  it("forwards other HTML attributes (e.g. data-testid)", () => {
    const { getByTestId } = render(
      <CardGrid data-testid="agent-grid">Content</CardGrid>,
    );
    expect(getByTestId("agent-grid")).toBeInTheDocument();
  });
});
