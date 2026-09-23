// @vitest-environment jsdom
// The phone shell at a 400 px container, with src/ui/phone.css's phone rules
// applied (src/test/phone.ts): the five-slot thumb bar, its Fleet count and
// active slot, the More sheet as a bottom-sheet dialog, the drawer's scrim, and
// a list table on the page labelled as cards.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { MouseEvent, ReactNode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { phoneWidth } from "@/test/phone";
import en from "../../../messages/en.json";
import shellMessages from "../../../messages/shell.json";
import uiMessages from "../../../messages/ui.json";
import { shellData } from "./shell.builders";
import { ShellClient } from "./shell-client";
import type { ShellData } from "./shell-data";

const nav = vi.hoisted(() => ({ pathname: "/acme/core-platform", query: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname.split("?")[0],
  // Both conventions, as in shell-client.test.tsx: `nav.query`, or a query
  // carried on `nav.pathname`.
  useSearchParams: () =>
    new URLSearchParams(nav.query || (nav.pathname.split("?")[1] ?? "")),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      {...rest}
      onClick={(e) => {
        e.preventDefault(); // jsdom cannot navigate documents
        onClick?.(e);
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock("@oxagen/ui", () => ({
  OxagenWordmark: () => <svg aria-hidden="true" />,
}));

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

let phone: ReturnType<typeof phoneWidth>;

beforeEach(() => {
  nav.pathname = "/acme/core-platform";
  phone = phoneWidth();
});

afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it, portals included.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
    phone.restore();
  }
});

function renderPhone(data: ShellData, page: ReactNode = null) {
  return render(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{
        ...en,
        ...shellMessages,
        ...uiMessages,
      }}
    >
      <ShellClient data={data} />
      <div data-shell-page="">
        <main id="main">{page}</main>
      </div>
    </NextIntlClientProvider>,
    { container: phone.container },
  );
}

const style = (el: Element) => getComputedStyle(el);

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("not rendered");
  return value;
}

function slots(): HTMLElement[] {
  return [
    ...screen
      .getByTestId("mobile-nav")
      .querySelectorAll<HTMLElement>("[data-slot]"),
  ];
}

describe("thumb bar", () => {
  it("renders five slots in order — Fleet, Agents, Tools, Spend, More — as 44 px targets over the safe-area inset", () => {
    renderPhone(shellData());
    const bar = screen.getByRole("navigation", { name: "Primary" });
    expect(slots().map((s) => s.dataset.slot)).toEqual([
      "fleet",
      "agents",
      "tools",
      "spend",
      "more",
    ]);
    expect(slots().map((s) => s.textContent)).toEqual([
      "Fleet",
      "Agents",
      "Tools",
      "Spend",
      "More",
    ]);
    expect(
      within(bar)
        .getAllByRole("link")
        .map((l) => l.getAttribute("href")),
    ).toEqual([
      "/acme/core-platform",
      "/acme/core-platform/agents",
      "/acme/core-platform/tools",
      "/acme/core-platform/spend",
    ]);
    for (const slot of slots()) {
      expect(style(slot).minHeight).toBe("44px");
      expect(style(slot).minWidth).toBe("44px");
    }
    expect(style(bar).paddingBottom).toBe(
      "calc(6px + env(safe-area-inset-bottom))",
    );
  });

  it("counts the approvals waiting on the Fleet slot and nowhere else", () => {
    renderPhone(shellData({ fleetWaiting: 3 }));
    const [fleet, ...rest] = slots();
    expect(fleet).toHaveAccessibleName("Fleet, 3 approvals waiting");
    expect(fleet?.querySelector("[data-count]")).toHaveAttribute(
      "data-count",
      "3",
    );
    // Agents, Tools and Spend point at NotRecorded pages; More holds no waiting work in rev1.
    for (const slot of rest)
      expect(slot.querySelector("[data-count]")).toBeNull();
  });

  it.each([0, null])(
    "shows no count when %s approvals wait or the count is not read (negative)",
    (fleetWaiting) => {
      renderPhone(shellData({ fleetWaiting }));
      expect(
        screen.getByTestId("mobile-nav").querySelector("[data-count]"),
      ).toBeNull();
      expect(slots()[0]).toHaveAccessibleName("Fleet");
    },
  );

  it.each([
    ["/acme/core-platform", "fleet"],
    ["/acme/core-platform/runs/run_01", "fleet"],
    ["/acme/core-platform/agents", "agents"],
    ["/acme/core-platform/tools", "tools"],
    ["/acme/core-platform/spend", "spend"],
    ["/acme/core-platform/steering", "more"],
    ["/acme/core-platform/runtimes", "more"],
    ["/acme/core-platform/repositories", "more"],
    ["/acme/billing", "more"],
    ["/acme/api-keys", "more"],
    ["/acme/model-funding", "more"],
    ["/acme/sso", "more"],
  ])("%s marks the %s slot current, and only it", (pathname, slot) => {
    nav.pathname = pathname;
    renderPhone(shellData());
    expect(
      slots()
        .filter((s) => s.getAttribute("aria-current") === "page")
        .map((s) => s.dataset.slot),
    ).toEqual([slot]);
  });

  it("keeps only More when the organization has no workspace the viewer can open (negative)", async () => {
    nav.pathname = "/acme/billing";
    renderPhone(shellData({ context: readOk({ orgs: [], workspaces: [] }) }));
    expect(slots().map((s) => s.dataset.slot)).toEqual(["more"]);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const sheet = await screen.findByRole("dialog", { name: "More" });
    expect(
      within(sheet)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Organization", "Billing", "Audit"]);
  });
});

describe("More sheet", () => {
  it("rises as a bottom sheet carrying Steering, Runtimes, Repositories, Organization, Billing and Audit", async () => {
    const user = userEvent.setup();
    renderPhone(shellData());
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    const sheet = await screen.findByRole("dialog", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "true");
    const links = within(sheet).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Steering", "/acme/core-platform/steering"],
      ["Runtimes", "/acme/core-platform/runtimes"],
      ["Repositories", "/acme/core-platform/repositories"],
      ["Organization", "/acme"],
      ["Billing", "/acme/billing"],
      ["Audit", "/acme/audit"],
    ]);
    for (const link of links) expect(style(link).minHeight).toBe("44px");

    // The bottom sheet: a drag handle, the safe-area inset, a full-width footer button, a scrim.
    expect(sheet).toHaveAttribute("data-sheet");
    expect(sheet.querySelector("[data-sheet-handle]")).not.toBeNull();
    expect(style(sheet).paddingBottom).toBe(
      "calc(0px + env(safe-area-inset-bottom))",
    );
    expect(style(sheet).width).toBe("100%");
    const close = within(sheet).getByRole("button", { name: "Close" });
    expect(close.parentElement).toHaveAttribute("data-sheet-footer");
    expect(style(close).flexGrow).toBe("1");
    expect(style(close).minHeight).toBe("44px");
    expect(document.querySelector("[data-scrim]")).not.toBeNull();

    await user.click(within(sheet).getByRole("link", { name: "Billing" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "More" })).toBeNull();
    });
  });

  it("closes from its footer button", async () => {
    const user = userEvent.setup();
    renderPhone(shellData());
    await user.click(screen.getByRole("button", { name: "More" }));
    const sheet = await screen.findByRole("dialog", { name: "More" });
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});

describe("the other dialogs on a phone", () => {
  it("the command menu rises as a sheet and its input is 16 px", async () => {
    const user = userEvent.setup();
    renderPhone(shellData());
    await user.click(screen.getByRole("button", { name: "Go to a page" }));
    const menu = await screen.findByTestId("command-menu");
    expect(menu).toHaveAttribute("data-sheet");
    expect(menu.querySelector("[data-sheet-handle]")).not.toBeNull();
    expect(style(within(menu).getByRole("combobox")).fontSize).toBe("16px");
  });

  it("the drawer opens over a scrim with the sidebar's ten links", async () => {
    const user = userEvent.setup();
    renderPhone(shellData());
    expect(document.querySelector("[data-scrim]")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByTestId("nav-drawer");
    expect(document.querySelector("[data-scrim]")).not.toBeNull();
    expect(
      within(drawer)
        .getByRole("navigation", { name: "Main" })
        .querySelectorAll("a"),
    ).toHaveLength(10);
  });

  // The rail that carries the launcher is `hidden md:flex`, so without this a
  // phone has no control that can open the assistant at all and ask_assistant
  // is unreachable below md (ADR-026).
  it("the drawer carries the assistant launcher as a 44 px target", async () => {
    const user = userEvent.setup();
    renderPhone(shellData());
    // Only the rail's, which `hidden md:flex` keeps off a phone, until then.
    expect(screen.getAllByTestId("assistant-launcher")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByTestId("nav-drawer");
    expect(screen.getAllByTestId("assistant-launcher")).toHaveLength(2);
    const launcher = within(drawer).getByTestId("assistant-launcher");
    expect(style(launcher).minHeight).toBe("44px");
    expect(launcher).toHaveAttribute("aria-expanded", "false");
  });

  it("the launcher opens the assistant and closes the drawer that would cover it", async () => {
    const user = userEvent.setup();
    renderPhone(shellData());
    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute("inert");
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByTestId("nav-drawer");
    await user.click(within(drawer).getByTestId("assistant-launcher"));
    await waitFor(() => {
      expect(screen.queryByTestId("nav-drawer")).toBeNull();
    });
    const flyout = screen.getByTestId("assistant-flyout");
    expect(flyout).not.toHaveAttribute("inert");
    expect(within(flyout).getByTestId("assistant-composer")).toBeTruthy();
  });

  // On a phone the control that opened the assistant is gone by the time the
  // assistant is open — the drawer unmounted it on the way out — so there is
  // nothing to hand focus back to. What must not happen is focus stranded on
  // a control inside a panel that has just gone `inert`: the next Tab then
  // resumes from nowhere. Focus resets to the document instead.
  it("does not strand focus inside the inert panel when the assistant closes on a phone", async () => {
    const user = userEvent.setup();
    renderPhone(shellData());
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByTestId("nav-drawer");
    await user.click(within(drawer).getByTestId("assistant-launcher"));
    await waitFor(() => {
      expect(screen.queryByTestId("nav-drawer")).toBeNull();
    });
    const flyout = screen.getByTestId("assistant-flyout");
    expect(flyout.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(flyout).toHaveAttribute("inert");
    });
    expect(flyout.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("card tables", () => {
  const runs = (rows: string[][]) => (
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>
            Agent <span>key</span>
          </th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((cells) => (
          <tr key={cells[0]}>
            {cells.map((cell) => (
              <td key={cell}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  it("labels each cell of a single-header list table with its column header, and hides the header row", async () => {
    const { rerender } = renderPhone(
      shellData(),
      runs([["run_01", "triage", "live"]]),
    );
    const table = screen.getByRole("table");
    await waitFor(() => {
      expect(table).toHaveAttribute("data-cards");
    });
    const labels = () =>
      [...table.querySelectorAll("tbody td")].map((td) =>
        td.getAttribute("data-label"),
      );
    expect(labels()).toEqual(["Run", "Agent key", "Status"]);
    expect(style(table).display).toBe("block");
    expect(style(present(table.querySelector("thead"))).display).toBe("none");

    // A row the page adds later is labelled too.
    rerender(
      <NextIntlClientProvider
        locale="en"
        timeZone="UTC"
        messages={{
          ...en,
          ...shellMessages,
          ...uiMessages,
        }}
      >
        <ShellClient data={shellData()} />
        <div data-shell-page="">
          <main id="main">
            {runs([
              ["run_01", "triage", "live"],
              ["run_02", "billing", "done"],
            ])}
          </main>
        </div>
      </NextIntlClientProvider>,
    );
    await waitFor(() => {
      expect(labels()).toEqual([
        "Run",
        "Agent key",
        "Status",
        "Run",
        "Agent key",
        "Status",
      ]);
    });
  });

  it("leaves a table with grouped headers as a grid (negative)", async () => {
    renderPhone(
      shellData(),
      <table>
        <thead>
          <tr>
            <th colSpan={2}>Spend</th>
          </tr>
          <tr>
            <th>Agent</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>triage</td>
            <td>12</td>
          </tr>
        </tbody>
      </table>,
    );
    // The effect has run once the shell's state provider has rendered the bar.
    await screen.findByTestId("mobile-nav");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const table = screen.getByRole("table");
    expect(table).not.toHaveAttribute("data-cards");
    expect(table.querySelector("[data-label]")).toBeNull();
  });
});
