// @vitest-environment jsdom
// A row of route tabs is a tab widget (ADR-NEW-route-tabs-are-tabs, #3995): a
// labelled tablist of tabs, each still a link to its own URL. The selected tab
// is the row's one stop in the tab order and names the panel the page draws,
// and the panel takes that tab as its label. The arrow keys, Home, and End move
// focus along the row, Space follows the focused tab, and a key pressed with a
// modifier stays the browser's. On a phone (audit-prompt check 14) the row
// scrolls sideways and snaps each tab to its start, as the mockup's
// `#viewport.phone .tabs` does; that rule lives in src/ui/phone.css and keys on
// the row's and the tab's data attributes, applied here at 400 px.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathOf, routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { phoneWidth } from "@/test/phone";
import { RouteTabPanel, RouteTabs, routeTabId } from "./route-tabs";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

const PEOPLE = {
  to: routes.people("acme"),
  label: "People",
  current: true,
  count: 3,
};
const TABS = [PEOPLE, { to: routes.roles("acme"), label: "Roles", current: false }];

const steeringTabs = [
  {
    to: pathOf("acme", "core", "steering"),
    label: "Library",
    current: false,
    name: "library",
  },
  {
    to: pathOf("acme", "core", "steering", "assignments"),
    label: "Assignments",
    current: true,
    name: "assignments",
  },
  {
    to: pathOf("acme", "core", "steering", "gates"),
    label: "Gates",
    current: false,
    name: "gates",
  },
  {
    to: pathOf("acme", "core", "steering", "proposals"),
    label: "Proposals",
    current: false,
    count: 4,
    name: "proposals",
  },
];

const tab = (name: string) =>
  screen.getByRole("tab", { name: new RegExp(`^${name}`) });

describe("RouteTabs", () => {
  it("draws a labelled tablist of tabs, each a link, with the current one selected and its count", () => {
    render(<RouteTabs label="Organization" panel="org-panel" tabs={TABS} />);
    const list = screen.getByRole("tablist", { name: "Organization" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((each) => each.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
    ]);
    expect(tabs[0]).toHaveAttribute("href", "/acme");
    expect(tabs[1]).toHaveAttribute("href", "/acme/roles");
    // The count sits in its own span beside the label.
    expect(tabs[0]?.querySelector("span")).toHaveTextContent("3");
    // One selected state: `aria-current` would announce the tab twice.
    for (const each of tabs) expect(each).not.toHaveAttribute("aria-current");
    expect(screen.queryAllByRole("link")).toEqual([]);
  });

  it("names the panel from the selected tab only, and the panel names that tab back", async () => {
    const { container } = render(
      <>
        <RouteTabs label="Steering" panel="steering-panel" tabs={steeringTabs} />
        <RouteTabPanel panel="steering-panel">
          <p>Assignment rows</p>
        </RouteTabPanel>
      </>,
    );
    const selected = tab("Assignments");
    const panel = screen.getByRole("tabpanel", { name: "Assignments" });
    expect(selected).toHaveAttribute("id", routeTabId("steering-panel"));
    expect(selected).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("id", "steering-panel");
    // The other tabs' panels are not on the page, so nothing points at them.
    for (const each of screen.getAllByRole("tab", { selected: false })) {
      expect(each).not.toHaveAttribute("aria-controls");
      expect(each).not.toHaveAttribute("id");
    }
    await expectNoAxe(container);
  });

  it("puts the selected tab, and only it, in the tab order", () => {
    render(
      <RouteTabs label="Steering" panel="steering-panel" tabs={steeringTabs} />,
    );
    expect(
      screen
        .getAllByRole("tab")
        .map((each) => each.getAttribute("tabindex")),
    ).toEqual(["-1", "0", "-1", "-1"]);
  });

  it("keeps a row with no tab selected in the tab order through its first tab", () => {
    render(
      <RouteTabs
        label="Organization"
        panel="org-panel"
        tabs={TABS.map((each) => ({ ...each, current: false }))}
      />,
    );
    expect(
      screen
        .getAllByRole("tab")
        .map((each) => each.getAttribute("tabindex")),
    ).toEqual(["0", "-1"]);
    expect(screen.queryByRole("tab", { selected: true })).toBeNull();
  });

  it("moves focus with the arrow keys, Home and End, wrapping at each end", () => {
    render(
      <RouteTabs label="Steering" panel="steering-panel" tabs={steeringTabs} />,
    );
    tab("Assignments").focus();
    fireEvent.keyDown(tab("Assignments"), { key: "ArrowRight" });
    expect(tab("Gates")).toHaveFocus();
    fireEvent.keyDown(tab("Gates"), { key: "End" });
    expect(tab("Proposals")).toHaveFocus();
    fireEvent.keyDown(tab("Proposals"), { key: "ArrowRight" });
    expect(tab("Library")).toHaveFocus();
    fireEvent.keyDown(tab("Library"), { key: "ArrowLeft" });
    expect(tab("Proposals")).toHaveFocus();
    fireEvent.keyDown(tab("Proposals"), { key: "Home" });
    expect(tab("Library")).toHaveFocus();
  });

  it("follows the focused tab on Space, and leaves other keys alone", () => {
    render(
      <RouteTabs label="Steering" panel="steering-panel" tabs={steeringTabs} />,
    );
    const gates = tab("Gates");
    const followed = vi.fn((event: Event) => {
      event.preventDefault();
    });
    gates.addEventListener("click", followed);
    fireEvent.keyDown(gates, { key: " " });
    expect(followed).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(gates, { key: "a" });
    expect(followed).toHaveBeenCalledTimes(1);
  });

  it("leaves Alt+ArrowLeft to the browser, which goes back (negative)", () => {
    render(
      <RouteTabs label="Steering" panel="steering-panel" tabs={steeringTabs} />,
    );
    const gates = tab("Gates");
    gates.focus();
    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.keyDown(gates, { key: "ArrowLeft", altKey: true })).toBe(
      true,
    );
    expect(fireEvent.keyDown(gates, { key: "ArrowRight", metaKey: true })).toBe(
      true,
    );
    expect(gates).toHaveFocus();
  });

  it("marks each tab with its name, so a test or a script can find it", () => {
    render(
      <RouteTabs label="Steering" panel="steering-panel" tabs={steeringTabs} />,
    );
    expect(document.querySelector('[data-tab="gates"]')).toBe(tab("Gates"));
  });

  it("draws a mark after the count as part of the tab's name", () => {
    render(
      <RouteTabs
        label="Run sections"
        panel="run-panel"
        tabs={[
          {
            ...PEOPLE,
            mark: <span className="sr-only">A call is parked</span>,
          },
        ]}
      />,
    );
    expect(screen.getByRole("tab", { name: /A call is parked/ })).toBe(
      document.querySelector('[role="tab"]'),
    );
  });

  it("leaves a panel with no tab selected unlabelled rather than pointing at nothing", () => {
    render(
      <RouteTabPanel panel="org-panel" labelled={false}>
        <p>Single sign-on</p>
      </RouteTabPanel>,
    );
    expect(screen.getByRole("tabpanel")).not.toHaveAttribute(
      "aria-labelledby",
    );
  });

  it("snaps each tab to its start on a phone", () => {
    const phone = phoneWidth();
    try {
      render(
        <RouteTabs
          label="Steering"
          panel="steering-panel"
          tabs={steeringTabs}
        />,
        { container: phone.container },
      );
      const list = screen.getByRole("tablist", { name: "Steering" });
      const row = list.parentElement;
      if (row === null) throw new Error("the tablist has no row");
      expect(row).toHaveAttribute("data-tab-row");
      expect(getComputedStyle(row).getPropertyValue("scroll-snap-type")).toBe(
        "x proximity",
      );
      const items = row.querySelectorAll("[data-tab]");
      expect(items).toHaveLength(4);
      for (const item of items)
        expect(
          getComputedStyle(item).getPropertyValue("scroll-snap-align"),
        ).toBe("start");
    } finally {
      phone.restore();
    }
  });
});
