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

  it("draws the h1 at the h2 step, the eyebrow at the micro step and the description at the base (ADR-298)", () => {
    render(
      <PageHeader title="Fleet" eyebrow="Workspace Core" description="Every agent in the workspace." />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("text-2xl");
    expect(screen.getByText("Workspace Core")).toHaveClass("text-sm", "uppercase");
    expect(screen.getByText("Every agent in the workspace.")).toHaveClass("text-base");
  });

  it("renders only the title when nothing else is given", () => {
    const { container } = render(<PageHeader title="Fleet" />);
    expect(container.querySelectorAll("p")).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
