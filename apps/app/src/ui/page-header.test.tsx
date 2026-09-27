// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PageHeader } from "./page-header";

afterEach(() => {
  cleanup();
});

describe("PageHeader", () => {
  it("renders the page's one h1 with every slot", () => {
    render(
      <PageHeader
        title="Refetch a stable list"
        eyebrow="Run"
        description="Sealed 4 minutes ago."
        meta={<span>sealed</span>}
        actions={<button type="button">Export</button>}
        figure={<span>$4.13</span>}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Refetch a stable list" }),
    ).toBeVisible();
    for (const text of ["Run", "Sealed 4 minutes ago.", "sealed", "$4.13"])
      expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByRole("button", { name: "Export" })).toBeVisible();
  });

  it("draws the leading avatar before the title", () => {
    render(
      <PageHeader
        title="Acme Robotics"
        leading={<span data-testid="leading">A</span>}
      />,
    );
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.previousElementSibling).toBe(screen.getByTestId("leading"));
  });

  it("renders only the title when nothing else is given", () => {
    const { container } = render(<PageHeader title="Fleet" />);
    expect(container.querySelectorAll("p")).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
