// @vitest-environment jsdom
// A row of route tabs: each tab a link to its own URL, the current one marked
// aria-current. With `tablist`, the row takes the design's tab semantics as
// well (a tablist of tabs, the current one selected); without it, it stays a
// plain list of links, so a row that never asked for tabs is not announced as
// one.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { routes } = await import("@/shared/safe-path");
const { RouteTabs } = await import("./route-tabs");

afterEach(cleanup);

const TABS = [
  { to: routes.people("acme"), label: "People", current: true, count: 3 },
  { to: routes.roles("acme"), label: "Roles", current: false },
];

describe("RouteTabs", () => {
  it("links each tab and marks only the current one, with its count", () => {
    render(<RouteTabs label="Organization" tabs={TABS} />);
    const nav = screen.getByRole("navigation", { name: "Organization" });
    // The count sits in its own span beside the label.
    const people = within(nav).getByRole("link", { name: /^People/ });
    expect(people.querySelector("span")).toHaveTextContent("3");
    expect(people).toHaveAttribute("href", "/acme");
    expect(people).toHaveAttribute("aria-current", "page");
    const roles = within(nav).getByRole("link", { name: "Roles" });
    expect(roles).toHaveAttribute("href", "/acme/roles");
    expect(roles).not.toHaveAttribute("aria-current");
  });

  it("draws no tab roles unless the row asks for them (negative)", () => {
    render(<RouteTabs label="Organization" tabs={TABS} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryAllByRole("tab")).toEqual([]);
    for (const link of screen.getAllByRole("link")) {
      expect(link).not.toHaveAttribute("aria-selected");
    }
  });

  it("draws a labelled tablist of tabs with the current one selected when asked", () => {
    render(<RouteTabs label="Organization" tabs={TABS} tablist />);
    const list = screen.getByRole("tablist", { name: "Organization" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
    ]);
    // Still links to their own URLs, and the current one still says so.
    expect(tabs[0]).toHaveAttribute("href", "/acme");
    expect(tabs[0]).toHaveAttribute("aria-current", "page");
    expect(tabs[1]).not.toHaveAttribute("aria-current");
    for (const item of list.querySelectorAll("li")) {
      expect(item).toHaveAttribute("role", "presentation");
    }
  });
});
