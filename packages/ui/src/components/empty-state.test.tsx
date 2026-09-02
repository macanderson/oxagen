// @vitest-environment jsdom
/**
 * empty-state.test.tsx — render tests for the shared EmptyState.
 *
 * Covers: title/description/action slots, icon tile, sizes, variants.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "lucide-react";
import { EmptyState } from "./empty-state";

afterEach(cleanup);

describe("EmptyState — render", () => {
  it("renders title, description, and action", () => {
    render(
      <EmptyState
        title="No connections yet"
        description="Connect a source to start."
        action={<button type="button">Add connection</button>}
      />,
    );
    expect(screen.getByText("No connections yet")).toBeInTheDocument();
    expect(screen.getByText("Connect a source to start.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add connection" }),
    ).toBeInTheDocument();
  });

  it("renders the icon inside a muted tile", () => {
    const { container } = render(
      <EmptyState icon={<Database />} title="Empty" />,
    );
    const tile = container.querySelector(".bg-muted");
    expect(tile).not.toBeNull();
    expect(tile?.querySelector("svg")).not.toBeNull();
  });

  it("small size tightens padding", () => {
    const { container } = render(<EmptyState title="Empty" size="sm" />);
    expect((container.firstChild as HTMLElement).className).toContain("py-6");
  });

  it("dashed variant draws a dashed container", () => {
    const { container } = render(<EmptyState title="Empty" variant="dashed" />);
    expect((container.firstChild as HTMLElement).className).toContain(
      "border-dashed",
    );
  });

  it("muted variant uses the soft filled container", () => {
    const { container } = render(<EmptyState title="Empty" variant="muted" />);
    expect((container.firstChild as HTMLElement).className).toContain(
      "bg-muted/20",
    );
  });

  it("plain variant has no container chrome", () => {
    const { container } = render(<EmptyState title="Empty" />);
    expect((container.firstChild as HTMLElement).className).not.toContain(
      "border",
    );
  });
});
