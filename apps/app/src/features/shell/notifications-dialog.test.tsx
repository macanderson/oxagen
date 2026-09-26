// @vitest-environment jsdom
// The bell and its dialog (mockup `notifsBody()`), the sidebar's counts, and
// the sidebar foot: what the chrome draws from the feed and the counts, with
// the open workspace's own reads (published by the workspace layout) taking
// the place of the organization's first workspace's. Mark all read is the
// governed write `mark_notification`, one per row, then a refresh.
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
import en from "../../../messages/en.json";
import shellMessages from "../../../messages/shell.json";
import uiMessages from "../../../messages/ui.json";
import { WorkspaceActivitySync } from "./activity-store";
import { approvalItem, shellData, shellWorkspace } from "./shell.builders";
import { ShellClient } from "./shell-client";
import type { ShellData } from "./shell-data";

const nav = vi.hoisted(() => ({
  pathname: "/acme/core-platform",
  refresh: vi.fn(),
}));

// The command menu's search_tools read answers nothing here; shell-client.test.tsx covers it.
vi.mock("./command-actions", () => ({
  searchCommands: () => Promise.resolve({ ok: true, value: { rows: [] } }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: nav.refresh }),
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

const { markNotificationsRead } = vi.hoisted(() => ({
  markNotificationsRead: vi.fn(),
}));
vi.mock("./notification-actions", () => ({ markNotificationsRead }));

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

beforeEach(() => {
  nav.pathname = "/acme/core-platform";
  nav.refresh.mockReset();
});

afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it, portals included.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function renderShell(data: ShellData, cards: Record<string, ReactNode> = {}) {
  return render(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ ...en, ...shellMessages, ...uiMessages }}
    >
      <ShellClient data={data} cards={cards} />
      <main id="main" />
    </NextIntlClientProvider>,
  );
}

const row = (id: string, unread: boolean) => ({
  id,
  title: "Approval waiting · github__create_release@2",
  body: "release-manager wants to cut the 4.11.0 release.",
  event: "approval.requested",
  kind: "approval" as const,
  unread,
  createdAt: "2026-09-23T09:14:00Z",
});

const feed = readOk({
  items: [row("ntf_01K5", true), row("ntf_02K5", false)],
  unread: 1,
});

function bell() {
  return within(screen.getByRole("banner", { name: "Top bar" })).getByRole(
    "button",
    { name: /^Notifications/ },
  );
}

describe("the bell", () => {
  it("names the unread count and carries the dot while anything is unread", () => {
    renderShell(shellData({ feed }));
    expect(bell()).toHaveAccessibleName("Notifications, 1 unread");
    expect(screen.getByTestId("unread-dot")).toBeInTheDocument();
  });

  it("carries no dot when everything is read (negative)", () => {
    renderShell(shellData({ feed: readOk({ items: [], unread: 0 }) }));
    expect(bell()).toHaveAccessibleName("Notifications, 0 unread");
    expect(screen.queryByTestId("unread-dot")).toBeNull();
  });

  it("claims no count when the feed could not be read (negative)", () => {
    renderShell(
      shellData({
        feed: { ok: false, reason: "error", code: "down", status: 503 },
      }),
    );
    expect(bell()).toHaveAccessibleName("Notifications");
    expect(screen.queryByTestId("unread-dot")).toBeNull();
  });
});

describe("the notifications dialog", () => {
  beforeEach(() => {
    markNotificationsRead.mockReset();
  });

  it("lists each row with its title, body, event and time, and names the read in the footer", async () => {
    const user = userEvent.setup();
    renderShell(shellData({ feed }));
    await user.click(bell());
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    const rows = within(dialog).getAllByTestId("notification");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-unread");
    expect(rows[1]).not.toHaveAttribute("data-unread");
    expect(rows[0]).toHaveTextContent(
      "Approval waiting · github__create_release@2",
    );
    expect(rows[0]).toHaveTextContent("approval.requested");
    expect(rows[0]?.querySelector("time")).toHaveAttribute(
      "dateTime",
      "2026-09-23T09:14:00Z",
    );
    expect(dialog).toHaveTextContent(
      "list_notifications · 1 unread · every kind here maps to a frame kind or an audit event, never to something invented for a bell.",
    );
  });

  it("marks every unread row read with mark_notification, then refreshes", async () => {
    const user = userEvent.setup();
    markNotificationsRead.mockResolvedValue({ ok: true, value: { marked: 1 } });
    renderShell(shellData({ feed }));
    await user.click(bell());
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    await user.click(
      within(dialog).getByRole("button", { name: "Mark all read" }),
    );
    expect(markNotificationsRead).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      ["ntf_01K5"],
    );
    await waitFor(() => {
      expect(nav.refresh).toHaveBeenCalled();
    });
    expect(within(dialog).getByTestId("mark-receipt")).toHaveTextContent(
      "Marked 1 read. Reading a notification is itself recorded, so the audit record shows who saw what.",
    );
  });

  it("says how many unread rows past the list it left unread", async () => {
    const user = userEvent.setup();
    markNotificationsRead.mockResolvedValue({ ok: true, value: { marked: 1 } });
    renderShell(
      shellData({
        feed: readOk({
          items: [row("ntf_01K5", true), row("ntf_02K5", false)],
          unread: 4,
        }),
      }),
    );
    await user.click(bell());
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    await user.click(
      within(dialog).getByRole("button", { name: "Mark all read" }),
    );
    expect(await within(dialog).findByTestId("mark-receipt")).toHaveTextContent(
      "3 older unread notifications are not listed here and stay unread.",
    );
  });

  it("never prints 0 unread when the unread count could not be read (negative)", async () => {
    const user = userEvent.setup();
    renderShell(
      shellData({
        feed: { ok: false, reason: "error", code: "down", status: 503 },
      }),
    );
    await user.click(bell());
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    expect(dialog).toHaveTextContent("unread count not recorded");
    expect(dialog).not.toHaveTextContent("0 unread");
  });

  it("says so when the write is refused, and does not refresh as if it worked (negative)", async () => {
    const user = userEvent.setup();
    markNotificationsRead.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "mark_notification",
    });
    renderShell(shellData({ feed }));
    await user.click(bell());
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    await user.click(
      within(dialog).getByRole("button", { name: "Mark all read" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "You do not have permission to mark these notifications.",
    );
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("offers no Mark all read when nothing is unread, and says when the feed is empty", async () => {
    const user = userEvent.setup();
    renderShell(shellData({ feed: readOk({ items: [], unread: 0 }) }));
    await user.click(bell());
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    expect(dialog).toHaveTextContent("No notifications.");
    expect(
      within(dialog).queryByRole("button", { name: "Mark all read" }),
    ).toBeNull();
  });

  it("names the refusal when the feed could not be read (negative)", async () => {
    const user = userEvent.setup();
    renderShell(
      shellData({
        feed: { ok: false, reason: "denied", permission: "workspace.read" },
      }),
    );
    await user.click(bell());
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    expect(dialog.querySelector('[data-reason="denied"]')).not.toBeNull();
  });
});

describe("the open workspace's own reads", () => {
  it("replace the organization's feed and light the Steering and Audit counts", async () => {
    renderShell(shellData({ feed }));
    act(() => {
      render(
        <WorkspaceActivitySync
          activity={{
            slug: "core-platform",
            counts: readOk({
              approvals: 0,
              interjections: null,
              proposals: 4,
              incidents: 2,
            }),
            feed: readOk({ items: [], unread: 7 }),
          }}
        />,
      );
    });
    await waitFor(() => {
      expect(bell()).toHaveAccessibleName("Notifications, 7 unread");
    });
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(
      within(main).getByRole("link", { name: /^Steering/ }),
    ).toHaveAccessibleName("Steering, 4 waiting");
    expect(
      within(main).getByRole("link", { name: /^Audit/ }),
    ).toHaveAccessibleName("Audit, 2 open");
  });

  it.each([
    [
      "answered no figure",
      readOk({
        approvals: 0,
        interjections: null,
        proposals: null,
        incidents: null,
      }),
    ],
    ["failed", readError("control_plane_unavailable", 503)],
  ])(
    "say the Steering and Audit counts are not recorded when the read %s, never zero (negative)",
    async (_why, counts) => {
      renderShell(shellData({ feed }));
      act(() => {
        render(
          <WorkspaceActivitySync
            activity={{
              slug: "core-platform",
              counts,
              feed: readOk({ items: [], unread: 0 }),
            }}
          />,
        );
      });
      const main = screen.getByRole("navigation", { name: "Main" });
      await waitFor(() => {
        expect(
          within(main).getByRole("link", { name: /^Steering/ }),
        ).toHaveAccessibleName("Steering, count not recorded");
      });
      expect(
        within(main).getByRole("link", { name: /^Audit/ }),
      ).toHaveAccessibleName("Audit, count not recorded");
      expect(
        main.querySelector('[data-count="audit"]')?.textContent,
      ).not.toMatch(/0/);
    },
  );

  it("are ignored when they belong to another workspace (negative)", () => {
    renderShell(shellData({ feed }));
    act(() => {
      render(
        <WorkspaceActivitySync
          activity={{
            slug: "finops",
            counts: readOk({
              approvals: 0,
              interjections: null,
              proposals: 4,
              incidents: 2,
            }),
            feed: readOk({ items: [], unread: 7 }),
          }}
        />,
      );
    });
    expect(bell()).toHaveAccessibleName("Notifications, 1 unread");
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(main.querySelector('[data-count="steering"]')).toBeNull();
  });
});

describe("the counts on an organization page", () => {
  // No workspace layout mounts on Organization, Billing or Audit, so the
  // chrome's own read of the first workspace (the one the sidebar points at
  // there) lights Steering and Audit, as the mock's Audit page draws them.
  it("light Steering and Audit from the chrome's read of the sidebar's workspace", () => {
    nav.pathname = "/acme/audit";
    renderShell(
      shellData({
        counts: {
          slug: "core-platform",
          read: readOk({
            approvals: 0,
            interjections: null,
            proposals: 10,
            incidents: 3,
          }),
        },
      }),
    );
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(
      within(main).getByRole("link", { name: /^Steering/ }),
    ).toHaveAccessibleName("Steering, 10 waiting");
    expect(
      within(main).getByRole("link", { name: /^Audit/ }),
    ).toHaveAccessibleName("Audit, 3 open");
  });

  it("say the counts are not recorded when that read failed, never zero (negative)", () => {
    nav.pathname = "/acme/billing";
    renderShell(
      shellData({
        counts: {
          slug: "core-platform",
          read: readError("control_plane_unavailable", 503),
        },
      }),
    );
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(
      within(main).getByRole("link", { name: /^Audit/ }),
    ).toHaveAccessibleName("Audit, count not recorded");
  });

  it("ignore a read made for another workspace (negative)", () => {
    nav.pathname = "/acme/audit";
    renderShell(
      shellData({
        counts: {
          slug: "finops",
          read: readOk({
            approvals: 0,
            interjections: null,
            proposals: 10,
            incidents: 3,
          }),
        },
      }),
    );
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(main.querySelector('[data-count="audit"]')).toBeNull();
    expect(main.querySelector('[data-count="steering"]')).toBeNull();
  });
});

describe("the sidebar's counts and foot", () => {
  it("counts only Fleet among the pages without a waiting store, from this workspace's queue", () => {
    renderShell(
      shellData({
        approvals: {
          workspaces: [
            shellWorkspace({
              pending: readOk({ items: [approvalItem()], more: false }),
            }),
          ],
          truncated: false,
          readAt: Date.now(),
        },
      }),
    );
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(
      [...main.querySelectorAll("[data-count]")].map((c) =>
        c.getAttribute("data-count"),
      ),
    ).toEqual(["fleet"]);
    expect(
      within(main).getByRole("link", { name: /^Fleet/ }),
    ).toHaveAccessibleName("Fleet, 1 waiting");
  });

  it("carries the connection badge and no caption for the missing organization read", () => {
    renderShell(shellData());
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    expect(within(sidebar).queryByTestId("sidebar-foot-not-backed")).toBeNull();
    expect(within(sidebar).getByTestId("connection")).toHaveTextContent(
      "connected",
    );
  });

  it("says offline the moment the browser drops, and connected again when it returns", () => {
    const onLine = vi.spyOn(window.navigator, "onLine", "get");
    try {
      onLine.mockReturnValue(true);
      renderShell(shellData());
      const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
      const badge = () => within(sidebar).getByTestId("connection");
      expect(badge()).toHaveAttribute("title");
      act(() => {
        onLine.mockReturnValue(false);
        window.dispatchEvent(new Event("offline"));
      });
      expect(badge()).toHaveTextContent("offline");
      // The reachable line claims the control plane answered; offline, it does not.
      expect(badge()).not.toHaveAttribute("title");
      act(() => {
        onLine.mockReturnValue(true);
        window.dispatchEvent(new Event("online"));
      });
      expect(badge()).toHaveTextContent("connected");
    } finally {
      onLine.mockRestore();
    }
  });

  it("draws Steering in the plain ink and Audit in the approval ink, and says Audit's incidents are open", () => {
    nav.pathname = "/acme/audit";
    renderShell(
      shellData({
        counts: {
          slug: "core-platform",
          read: readOk({
            approvals: 0,
            interjections: null,
            proposals: 2,
            incidents: 1,
          }),
        },
      }),
    );
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(main.querySelector('[data-count="steering"]')).not.toHaveClass(
      "text-info",
    );
    expect(main.querySelector('[data-count="audit"]')).toHaveClass("text-info");
    expect(
      within(main).getByRole("link", { name: /^Audit/ }),
    ).toHaveAccessibleName("Audit, 1 open");
  });
});
