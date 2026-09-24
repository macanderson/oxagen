// @vitest-environment jsdom
// A row of route tabs: each tab a link to its own URL, the current one marked
// aria-current. With `tablist`, the row takes the design's tab semantics as
// well (a tablist of tabs, the current one selected); without it, it stays a
// plain list of links, so a row that never asked for tabs is not announced as
// one. On a phone (audit-prompt check 14) the row scrolls sideways and snaps
// each tab to its start, as the mockup's `#viewport.phone .tabs` does; that
// rule lives in src/ui/phone.css and keys on the row's and the tab's data
// attributes, applied here at 400 px.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathOf, routes } from "@/shared/safe-path";
import { phoneWidth } from "@/test/phone";
import { RouteTabs } from "./route-tabs";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

const TABS = [
  { to: routes.people("acme"), label: "People", current: true, count: 3 },
  { to: routes.roles("acme"), label: "Roles", current: false },
];

const steeringTabs = [
  { to: pathOf("acme", "core", "steering"), label: "Library", current: true },
  {
    to: pathOf("acme", "core", "steering", "proposals"),
    label: "Proposals",
    current: false,
    count: 4,
  },
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

  it("marks the current tab and snaps each tab to its start on a phone", () => {
    const phone = phoneWidth();
    try {
      render(<RouteTabs label="Steering" tabs={steeringTabs} />, {
        container: phone.container,
      });
      const row = screen.getByRole("navigation", { name: "Steering" });
      expect(row).toHaveAttribute("data-tab-row");
      expect(getComputedStyle(row).getPropertyValue("scroll-snap-type")).toBe(
        "x proximity",
      );
      const items = row.querySelectorAll("[data-tab]");
      expect(items).toHaveLength(2);
      for (const item of items)
        expect(
          getComputedStyle(item).getPropertyValue("scroll-snap-align"),
        ).toBe("start");
      expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(
        screen.getByRole("link", { name: /Proposals/ }),
      ).not.toHaveAttribute("aria-current");
    } finally {
      phone.restore();
    }
  });
});
