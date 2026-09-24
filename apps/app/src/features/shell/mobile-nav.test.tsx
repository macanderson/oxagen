// @vitest-environment jsdom
// The phone shell at a 400 px container, with src/ui/phone.css's phone rules
// applied (src/test/phone.ts): the five-slot thumb bar, its Fleet count and
// active slot, the More sheet as a bottom-sheet dialog, the drawer's scrim, and
// a list table on the page labelled as cards.
import {
  act,
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
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { phoneWidth } from "@/test/phone";
import en from "../../../messages/en.json";
import createMessages from "../../../messages/create.json";
import shellMessages from "../../../messages/shell.json";
import uiMessages from "../../../messages/ui.json";
import { approvalItem, shellData, shellWorkspace } from "./shell.builders";
import { ShellClient } from "./shell-client";
import type { ShellData } from "./shell-data";

const nav = vi.hoisted(() => ({ pathname: "/acme/core-platform", query: "" }));

// The command menu's search_tools read answers nothing here; shell-client.test.tsx covers it.
vi.mock("./command-actions", () => ({
  searchCommands: () => Promise.resolve({ ok: true, value: { rows: [] } }),
}));
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
        ...createMessages,
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

  const waitingIn = (count: number, more = false) =>
    shellData({
      approvals: {
        workspaces: [
          shellWorkspace({
            pending: readOk({
              items: Array.from({ length: count }, (_, i) =>
                approvalItem({ id: `apr_0${String(i)}` }),
              ),
              more,
            }),
          }),
        ],
        truncated: false,
        readAt: 0,
      },
    });

  it("counts the approvals waiting in this workspace on the Fleet slot and nowhere else", () => {
    renderPhone(waitingIn(3));
    const [fleet, ...rest] = slots();
    expect(fleet).toHaveAccessibleName("Fleet, 3 approvals waiting");
    expect(fleet?.querySelector("[data-count]")).toHaveAttribute(
      "data-count",
      "3",
    );
    // `.mn .ct { background: var(--panel) }`, whatever the page body is on.
    expect(fleet?.querySelector("[data-count]")).toHaveClass(
      "bg-app-raised-bg",
    );
    // More carries Audit's critical incidents, which no store records yet.
    for (const slot of rest)
      expect(slot.querySelector("[data-count]")).toBeNull();
  });

  it('says "+" on the Fleet slot when the queue ran past the read', () => {
    renderPhone(waitingIn(2, true));
    expect(slots()[0]?.querySelector("[data-count]")).toHaveTextContent("2+");
  });

  it("shows no count when nothing waits (negative)", () => {
    renderPhone(waitingIn(0));
    expect(
      screen.getByTestId("mobile-nav").querySelector("[data-count]"),
    ).toBeNull();
    expect(slots()[0]).toHaveAccessibleName("Fleet");
  });

  it("shows no count when the workspace's queue could not be read, never a zero (negative)", () => {
    renderPhone(
      shellData({
        approvals: {
          workspaces: [
            shellWorkspace({
              pending: {
                ok: false,
                reason: "error",
                code: "run_index_unavailable",
                status: 503,
              },
            }),
          ],
          truncated: false,
          readAt: 0,
        },
      }),
    );
    expect(
      screen.getByTestId("mobile-nav").querySelector("[data-count]"),
    ).toBeNull();
  });

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
    // `.mn[aria-current=page]::before`: the gold bar sits over that slot alone.
    expect(
      slots()
        .filter((s) => s.querySelector("[data-current-marker]") !== null)
        .map((s) => s.dataset.slot),
    ).toEqual([slot]);
  });

  it("does not call More the current page because its sheet is open (negative)", async () => {
    nav.pathname = "/acme/core-platform";
    renderPhone(shellData());
    const more = screen.getByRole("button", { name: "More" });
    await userEvent.click(more);
    await screen.findByRole("dialog", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(more).not.toHaveAttribute("aria-current");
  });

  it("carries Audit's count on More on an organization page, from the chrome's own read", () => {
    nav.pathname = "/acme/audit";
    renderPhone(
      shellData({
        counts: {
          slug: "core-platform",
          read: readOk({ approvals: 0, proposals: 10, incidents: 3 }),
        },
      }),
    );
    expect(screen.getByRole("button", { name: /^More/ })).toHaveAccessibleName(
      "More, 3 critical incidents open",
    );
  });

  it("marks More's count not recorded when the read failed, never zero (negative)", () => {
    nav.pathname = "/acme/audit";
    renderPhone(
      shellData({
        counts: {
          slug: "core-platform",
          read: readError("control_plane_unavailable", 503),
        },
      }),
    );
    expect(screen.getByRole("button", { name: /^More/ })).toHaveAccessibleName(
      "More, count not recorded",
    );
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
        .map((l) => l.querySelector("b")?.textContent),
    ).toEqual(["Organization", "Billing", "Audit"]);
    // With no workspace there is none to switch to.
    expect(within(sheet).queryByTestId("more-switch-ws")).toBeNull();
  });
});

describe("More sheet", () => {
  it("rises as a bottom sheet carrying Steering, Runtimes, Repositories, Organization, Billing and Audit, each with its line", async () => {
    const user = userEvent.setup();
    renderPhone(shellData());
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    const sheet = await screen.findByRole("dialog", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "true");
    const links = within(sheet).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      [
        "Steeringlibrary, assignments, gates, proposals, compiler",
        "/acme/core-platform/steering",
      ],
      [
        "Runtimeshosts, harnesses, hooks, tiers",
        "/acme/core-platform/runtimes",
      ],
      [
        "Repositoriesbindings, working copies, changes",
        "/acme/core-platform/repositories",
      ],
      ["Organizationpeople, workspaces, funding", "/acme"],
      ["Billingplan, meters, invoices", "/acme/billing"],
      ["Auditevents, incidents, holds", "/acme/audit"],
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
    // The mockup's header ✕ sits beside the title as well.
    expect(
      within(sheet).getByRole("button", { name: "Close More" }),
    ).toHaveAttribute("data-dialog-dismiss");
    expect(style(close).flexGrow).toBe("1");
    expect(style(close).minHeight).toBe("44px");
    expect(document.querySelector("[data-scrim]")).not.toBeNull();

    await user.click(within(sheet).getByRole("link", { name: /^Billing/ }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "More" })).toBeNull();
    });
  });

  it("carries the assistant, search, notifications, the account and both switchers", async () => {
    const user = userEvent.setup();
    renderPhone(shellData());
    await user.click(screen.getByRole("button", { name: "More" }));
    const sheet = await screen.findByRole("dialog", { name: "More" });
    expect(
      [
        "more-assistant",
        "more-search",
        "more-notifications",
        "more-account",
        "more-switch-org",
        "more-switch-ws",
      ].map((id) => within(sheet).getByTestId(id).textContent),
    ).toEqual([
      "Assistantask about a run, or change something",
      "Searchor run an action",
      "Notifications0 unread",
      "AccountMarcus Bell",
      "Switch organizationAcme Robotics",
      "Switch workspaceCore platform",
    ]);
    for (const id of ["more-search", "more-switch-ws"])
      expect(style(within(sheet).getByTestId(id)).minHeight).toBe("44px");
  });

  it("closes itself before opening the dialog a tile names, so two sheets never stack", async () => {
    const user = userEvent.setup();
    renderPhone(shellData());
    await user.click(screen.getByRole("button", { name: "More" }));
    let sheet = await screen.findByRole("dialog", { name: "More" });
    await user.click(within(sheet).getByTestId("more-switch-ws"));
    const switcher = await screen.findByRole("dialog", {
      name: "Switch workspace",
    });
    expect(
      within(switcher).getByRole("link", { name: /Core platform/ }),
    ).toHaveAttribute("aria-current", "true");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "More" })).toBeNull();
    });
    await user.click(within(switcher).getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "More" }));
    sheet = await screen.findByRole("dialog", { name: "More" });
    await user.click(within(sheet).getByTestId("more-notifications"));
    expect(
      await screen.findByRole("dialog", { name: "Notifications" }),
    ).toBeInTheDocument();
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
    await user.click(
      screen.getByRole("button", { name: "Search or run an action" }),
    );
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
    // The mock's drawer opens on the brand and the switchers, with no close
    // row: the scrim and Escape close it.
    expect(
      within(drawer).queryByRole("button", { name: "Close navigation" }),
    ).toBeNull();
    expect(
      within(drawer)
        .getByRole("navigation", { name: "Main" })
        .querySelectorAll("a"),
    ).toHaveLength(10);
  });

  it("the drawer closes when the window widens past the breakpoint, so no invisible modal holds focus", async () => {
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
        listeners.push(fn);
      },
      removeEventListener: () => undefined,
    }));
    try {
      const user = userEvent.setup();
      renderPhone(shellData());
      await user.click(screen.getByRole("button", { name: "Open navigation" }));
      await screen.findByTestId("nav-drawer");
      expect(listeners.length).toBeGreaterThan(0);
      act(() => {
        for (const fn of listeners) fn({ matches: true });
      });
      await waitFor(() => {
        expect(screen.queryByTestId("nav-drawer")).toBeNull();
      });
    } finally {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
    }
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
          ...createMessages,
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
