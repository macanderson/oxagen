// @vitest-environment jsdom
/**
 * breadcrumb.test.tsx — render tests for the Breadcrumb component.
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { Breadcrumb } from "./breadcrumb";

afterEach(cleanup);

describe("Breadcrumb — render", () => {
  it("renders a nav with aria-label=Breadcrumb", () => {
    const { getByRole } = render(<Breadcrumb items={[{ label: "Home" }]} />);
    expect(getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
  });

  it("renders single item as current page with no link", () => {
    const { getByText } = render(
      <Breadcrumb items={[{ label: "Settings" }]} />,
    );
    const span = getByText("Settings");
    expect(span.tagName.toLowerCase()).toBe("span");
    expect(span).toHaveAttribute("aria-current", "page");
  });

  it("renders middle items as links when href is provided", () => {
    const { getByRole } = render(
      <Breadcrumb
        items={[{ label: "Home", href: "/" }, { label: "Settings" }]}
      />,
    );
    const link = getByRole("link", { name: "Home" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/");
  });

  it("renders last item as aria-current=page regardless of href presence", () => {
    const { getByText } = render(
      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: "Billing", href: "/billing" },
        ]}
      />,
    );
    const billing = getByText("Billing");
    expect(billing).toHaveAttribute("aria-current", "page");
  });

  it("renders chevron separators between items", () => {
    const { container } = render(
      <Breadcrumb items={[{ label: "A", href: "/" }, { label: "B" }]} />,
    );
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThan(0);
  });

  it("merges custom className", () => {
    const { getByRole } = render(
      <Breadcrumb items={[{ label: "Test" }]} className="my-breadcrumb" />,
    );
    expect(getByRole("navigation").className).toContain("my-breadcrumb");
  });

  it("item without href at non-last position renders as span not link", () => {
    const { queryAllByRole } = render(
      <Breadcrumb
        items={[
          { label: "Level 1" }, // no href → span (non-last but no href)
          { label: "Level 2" }, // last
        ]}
      />,
    );
    expect(queryAllByRole("link")).toHaveLength(0);
  });
});
