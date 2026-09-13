// @vitest-environment jsdom
/**
 * settings-nav.test.tsx — render tests for SettingsNav + MobileSettingsNav.
 *
 * Covers:
 *   - SettingsNav renders every item as a link and marks the active one.
 *   - MobileSettingsNav trigger shows the active section label and meets the
 *     44px touch-target floor (h-11).
 *   - Opening the sheet exposes EVERY item (mobile feature parity, ADR-026) —
 *     the two components must always present the identical item list.
 *   - Selecting an item closes the sheet.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  within,
  waitFor,
  cleanup,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { pathnameRef } = vi.hoisted(() => ({
  pathnameRef: { current: "/acme/prod/settings/members" },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import {
  SettingsNav,
  MobileSettingsNav,
  type SettingsNavItem,
} from "./settings-nav";

const items: SettingsNavItem[] = [
  { label: "General", href: "/acme/prod/settings/general" },
  { label: "Members", href: "/acme/prod/settings/members" },
  { label: "Models", href: "/acme/prod/settings/models" },
];

afterEach(() => {
  cleanup();
  pathnameRef.current = "/acme/prod/settings/members";
});

describe("SettingsNav", () => {
  it("renders every item as a link with its href", () => {
    render(<SettingsNav items={items} />);
    const nav = screen.getByRole("navigation", { name: "Settings" });
    for (const item of items) {
      expect(
        within(nav).getByRole("link", { name: item.label }),
      ).toHaveAttribute("href", item.href);
    }
  });

  it("marks the active item with aria-current=page", () => {
    render(<SettingsNav items={items} />);
    expect(screen.getByRole("link", { name: "Members" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "General" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});

describe("MobileSettingsNav", () => {
  it("renders a thumb-sized trigger labelled with the active section", () => {
    render(<MobileSettingsNav items={items} label="Workspace settings" />);
    const trigger = screen.getByTestId("settings-mobile-nav-trigger");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    // 44px touch-target floor: h-11 (2.75rem).
    expect(trigger.className).toContain("h-11");
    expect(within(trigger).getByText("Members")).toBeInTheDocument();
  });

  it("renders nothing when there are no items", () => {
    const { container } = render(
      <MobileSettingsNav items={[]} label="Workspace settings" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the bottom sheet exposing EVERY section (mobile feature parity)", async () => {
    render(<MobileSettingsNav items={items} label="Workspace settings" />);
    await userEvent.click(screen.getByTestId("settings-mobile-nav-trigger"));
    const sheetNav = await screen.findByTestId("settings-mobile-nav-sheet");
    const links = within(sheetNav).getAllByRole("link");
    // Parity: the sheet must present the identical item list, nothing dropped.
    expect(links.map((l) => l.getAttribute("href"))).toEqual(
      items.map((i) => i.href),
    );
    expect(
      within(sheetNav).getByRole("link", { name: "Members" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("closes the sheet when a section is selected", async () => {
    render(<MobileSettingsNav items={items} label="Workspace settings" />);
    await userEvent.click(screen.getByTestId("settings-mobile-nav-trigger"));
    const sheetNav = await screen.findByTestId("settings-mobile-nav-sheet");
    await userEvent.click(
      within(sheetNav).getByRole("link", { name: "General" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByTestId("settings-mobile-nav-sheet"),
      ).not.toBeInTheDocument();
    });
  });
});
