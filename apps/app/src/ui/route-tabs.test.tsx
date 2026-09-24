// @vitest-environment jsdom
// A tab row on a phone (audit-prompt check 14): it scrolls sideways and snaps
// each tab to its start, as the mockup's `#viewport.phone .tabs` does. The
// rule lives in src/ui/phone.css and keys on the row's and the tab's data
// attributes, applied here at 400 px.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathOf } from "@/shared/safe-path";
import { phoneWidth } from "@/test/phone";
import { RouteTabs } from "./route-tabs";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

const tabs = [
  { to: pathOf("acme", "core", "steering"), label: "Library", current: true },
  {
    to: pathOf("acme", "core", "steering", "proposals"),
    label: "Proposals",
    current: false,
    count: 4,
  },
];

describe("RouteTabs", () => {
  it("marks the current tab and snaps each tab to its start on a phone", () => {
    const phone = phoneWidth();
    try {
      render(<RouteTabs label="Steering" tabs={tabs} />, {
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
