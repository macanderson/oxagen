// @vitest-environment jsdom
// The topbar's approvals and notification badges while both drawers are
// closed: they read the idle poll, never the drawer's read across every
// workspace, and a detailed value left from an earlier opening does not freeze
// them. Then the two drawers themselves: every state of the approvals read and
// of the notifications list, and what marking a notification does when the
// write fails.
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
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import shellMessages from "../../../messages/shell.json";
import {
  ActivityButtons,
  ActivityDrawers,
  ShellActivityProvider,
} from "./activity";
import { shellData } from "./shell.builders";
import { ShellStateProvider, useShellState } from "./shell-state";

const actions = vi.hoisted(() => ({
  readShellActivity: vi.fn(),
  readShellNavCounts: vi.fn(),
  readShellUnreadCount: vi.fn(),
  markShellNotification: vi.fn(),
}));
vi.mock("./activity-actions", () => actions);
// The panel is Fleet's and has its own tests; this stand-in shows what the
// drawer hands it and lets a test resolve the approval.
vi.mock("@/features/fleet/client", () => ({
  ApprovalsPanel: ({
    ws,
    mandates,
    onResolved,
  }: {
    ws: string;
    mandates: Map<string, unknown>;
    onResolved: () => void;
  }) => (
    <div data-testid="approvals-panel">
      <span>{`panel ${ws} with ${String(mandates.size)} mandates`}</span>
      <button type="button" onClick={onResolved}>
        resolve
      </button>
    </div>
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/core-platform",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const ok = <T,>(value: T) => ({ ok: true as const, value });
const navCounts = (approvals: number | null) =>
  ok({ approvals, proposals: null, incidents: null });
const unread = (unreadCount: number) => ok({ notifications: [], unreadCount });

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
  vi.resetAllMocks();
  actions.readShellNavCounts.mockResolvedValue(navCounts(3));
  actions.readShellUnreadCount.mockResolvedValue(unread(2));
  actions.readShellActivity.mockResolvedValue(
    ok({
      workspaces: [
        {
          slug: "core-platform",
          name: "Core platform",
          pending: ok({ items: [{ id: "a" }], more: false }),
        },
      ],
      notifications: { items: [], partial: false, failures: [] },
      currentWorkspace: "core-platform",
      readAt: "2026-09-23T00:00:00Z",
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Opener() {
  const { setApprovalsOpen } = useShellState();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setApprovalsOpen(true);
        }}
      >
        open drawer
      </button>
      <button
        type="button"
        onClick={() => {
          setApprovalsOpen(false);
        }}
      >
        close drawer
      </button>
    </>
  );
}

function renderButtons() {
  return render(
    <NextIntlClientProvider locale="en" messages={shellMessages}>
      <ShellStateProvider>
        <ShellActivityProvider data={shellData()}>
          <ActivityButtons />
          <Opener />
        </ShellActivityProvider>
      </ShellStateProvider>
    </NextIntlClientProvider>,
  );
}

describe("activity badges with the drawers closed", () => {
  it("show the idle approval count and unread dot without the detailed read", async () => {
    const { container } = renderButtons();
    expect(await screen.findByLabelText("2 unread notifications")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approvals" }).textContent,
    ).toContain("3");
    expect(actions.readShellActivity).not.toHaveBeenCalled();
    expect(actions.readShellUnreadCount).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
    await expectNoAxe(container);
  });

  it("render no dot when nothing is unread", async () => {
    actions.readShellUnreadCount.mockResolvedValue(unread(0));
    renderButtons();
    await waitFor(() => {
      expect(actions.readShellUnreadCount).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
  });

  it("return to the idle poll after a drawer closes instead of freezing on the detailed read", async () => {
    const user = userEvent.setup();
    renderButtons();
    await screen.findByLabelText("2 unread notifications");

    await user.click(screen.getByRole("button", { name: "open drawer" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Approvals" }).textContent,
      ).toContain("1");
    });

    await user.click(screen.getByRole("button", { name: "close drawer" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Approvals" }).textContent,
      ).toContain("3");
    });
    expect(screen.getByLabelText("2 unread notifications")).toBeTruthy();
  });

  it.each([
    [
      "both idle reads reject",
      () => {
        actions.readShellNavCounts.mockRejectedValue(new Error("network"));
        actions.readShellUnreadCount.mockRejectedValue(new Error("network"));
      },
    ],
    [
      "the count carries no approvals and the unread read is refused",
      () => {
        actions.readShellNavCounts.mockResolvedValue(navCounts(null));
        actions.readShellUnreadCount.mockResolvedValue({
          ok: false,
          reason: "denied",
          code: "notifications.read",
        });
      },
    ],
  ])("show no count and no dot when %s", async (_case, arrange) => {
    arrange();
    renderButtons();
    await waitFor(() => {
      expect(actions.readShellUnreadCount).toHaveBeenCalled();
      expect(actions.readShellNavCounts).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Approvals" }).textContent).toBe(
      "Approvals",
    );
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
  });

  it("pick up new activity on the next idle poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderButtons();
    await screen.findByLabelText("2 unread notifications");
    actions.readShellUnreadCount.mockResolvedValue(unread(5));
    actions.readShellNavCounts.mockResolvedValue(navCounts(4));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(await screen.findByLabelText("5 unread notifications")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approvals" }).textContent,
    ).toContain("4");
    expect(actions.readShellActivity).not.toHaveBeenCalled();
  });
});

const fail = (reason: string, code: string) => ({ ok: false, reason, code });
const item = (id: string, extra: Record<string, string | null> = {}) => ({
  id,
  tool: `tool_${id}`,
  agentKey: null,
  runId: null,
  ...extra,
});
const workspace = (
  slug: string,
  pending: unknown,
  resolved: unknown = ok({ items: [], nextCursor: null }),
  mandates: unknown = ok({ mandates: [{ id: "m1" }, { id: "m2" }] }),
) => ({ slug, name: `Workspace ${slug}`, pending, resolved, mandates });
const notification = (
  publicId: string,
  extra: Record<string, unknown> = {},
) => ({
  notification: {
    publicId,
    title: `Title ${publicId}`,
    body: null,
    deepLink: null,
    unread: false,
    createdAt: "2026-09-23T00:00:00Z",
    ...extra,
  },
  ws: "core-platform",
});
const activity = (
  workspaces: unknown[],
  notifications: unknown = { items: [], partial: false, failures: [] },
) =>
  ok({
    workspaces,
    notifications,
    currentWorkspace: "core-platform",
    readAt: "2026-09-23T00:00:00Z",
  });

function DrawerOpeners() {
  const { setApprovalsOpen, setNotificationsOpen } = useShellState();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setApprovalsOpen(true);
        }}
      >
        open approvals
      </button>
      <button
        type="button"
        onClick={() => {
          setNotificationsOpen(true);
        }}
      >
        open notifications
      </button>
    </>
  );
}

async function openDrawer(which: "approvals" | "notifications") {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <ShellStateProvider>
        <ShellActivityProvider data={shellData()}>
          <DrawerOpeners />
          <ActivityButtons />
          <ActivityDrawers data={shellData()} />
        </ShellActivityProvider>
      </ShellStateProvider>
    </IntlProvider>,
  );
  await user.click(screen.getByRole("button", { name: `open ${which}` }));
  const drawer = await screen.findByTestId(`${which}-drawer`);
  return { user, drawer };
}

describe("the approvals drawer", () => {
  it("says it is loading until the read answers", async () => {
    actions.readShellActivity.mockReturnValue(new Promise(() => undefined));
    const { drawer } = await openDrawer("approvals");
    expect(within(drawer).getByRole("status").textContent).toBe(
      "Loading activity",
    );
  });

  it.each([
    [
      fail("denied", "workspace.approvals.read"),
      "denied",
      "Your roles do not include workspace.approvals.read",
    ],
    [
      { ok: false, reason: "pending_approval", accessRequestId: "ar_9" },
      "pending_approval",
      "waiting for approval, request ar_9",
    ],
    [fail("unavailable", "store_down"), "error", "answered store_down"],
  ])(
    "names a refused read in place of the list (%#)",
    async (read, reason, text) => {
      actions.readShellActivity.mockResolvedValue(read);
      const { drawer } = await openDrawer("approvals");
      const failure = await waitFor(() => {
        const node = drawer.querySelector(`[data-reason="${reason}"]`);
        expect(node).not.toBeNull();
        return node;
      });
      expect(failure?.textContent).toContain(text);
    },
  );

  it("alerts when the read throws, and reads again on Refresh", async () => {
    actions.readShellActivity.mockRejectedValue(new Error("network"));
    const { user, drawer } = await openDrawer("approvals");
    expect((await within(drawer).findByRole("alert")).textContent).toBe(
      "Activity could not be refreshed. Try again.",
    );
    actions.readShellActivity.mockResolvedValue(activity([]));
    await user.click(within(drawer).getByRole("button", { name: "Refresh" }));
    expect(
      await within(drawer).findByText("No accessible workspaces"),
    ).toBeTruthy();
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });

  it("shows each workspace's pending and resolved approvals in every state", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity([
        workspace(
          "refused",
          { ok: false, reason: "denied", permission: "approvals.read" },
          { ok: false, reason: "error", code: "resolved_down" },
        ),
        workspace(
          "quiet",
          ok({ items: [], more: false }),
          ok({ items: [{ id: "r1" }], nextCursor: "c2" }),
        ),
        workspace(
          "busy",
          ok({
            items: [
              item("a1", { agentKey: "agent-deploy" }),
              item("a2", { runId: "run_42" }),
              item("a3"),
            ],
            more: true,
          }),
        ),
      ]),
    );
    const { drawer } = await openDrawer("approvals");
    await within(drawer).findByText("Workspace busy");
    const refused = within(drawer)
      .getByText("Workspace refused")
      .closest("section");
    expect(refused?.querySelector('[data-reason="denied"]')).not.toBeNull();
    expect(refused?.querySelector('[data-reason="error"]')?.textContent).toBe(
      "Resolved approvals could not be loaded: the control plane answered resolved_down. Nothing was changed, and runs kept recording.",
    );
    const quiet = within(drawer)
      .getByText("Workspace quiet")
      .closest("section");
    expect(quiet?.textContent).toContain("No approvals waiting");
    expect(quiet?.textContent).toContain("1 resolved today (UTC)+");
    const busy = within(drawer).getByText("Workspace busy").closest("section");
    expect(busy?.textContent).toContain("agent-deploy");
    expect(busy?.textContent).toContain("run_42");
    expect(busy?.textContent).toContain("a3");
    expect(busy?.textContent).toContain(
      "More approvals are waiting than this list can show.",
    );
    expect(busy?.textContent).toContain("0 resolved today (UTC)");
    expect(busy?.textContent).not.toContain("(UTC)+");
    // The badge counts every loaded item and marks the list incomplete. The
    // open drawer makes the topbar inert, so it is found among hidden nodes.
    expect(
      screen.getByRole("button", { name: "Approvals", hidden: true })
        .textContent,
    ).toContain("3+");
    expect(within(drawer).queryByText("No accessible workspaces")).toBeNull();
  });

  it("opens one approval in the panel, refreshes when it resolves, and goes back to all", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity([
        workspace("busy", ok({ items: [item("a1")], more: false })),
        workspace(
          "blind",
          ok({ items: [item("b1")], more: false }),
          undefined,
          fail("denied", "mandates.read"),
        ),
      ]),
    );
    const { user, drawer } = await openDrawer("approvals");
    await user.click(
      await within(drawer).findByRole("button", { name: /tool_a1/ }),
    );
    expect(within(drawer).getByText("panel busy with 2 mandates")).toBeTruthy();
    expect(within(drawer).queryByText("Workspace blind")).toBeNull();

    const reads = actions.readShellActivity.mock.calls.length;
    await user.click(within(drawer).getByRole("button", { name: "resolve" }));
    await waitFor(() => {
      expect(actions.readShellActivity.mock.calls.length).toBeGreaterThan(
        reads,
      );
    });

    await user.click(
      within(drawer).getByRole("button", { name: "All approvals" }),
    );
    await user.click(within(drawer).getByRole("button", { name: /tool_b1/ }));
    // A workspace whose mandates read was refused hands the panel none.
    expect(
      within(drawer).getByText("panel blind with 0 mandates"),
    ).toBeTruthy();
  });
});

describe("the notifications drawer", () => {
  it("shows the read's status until the list arrives", async () => {
    actions.readShellActivity.mockResolvedValue(fail("denied", "notify.read"));
    const { drawer } = await openDrawer("notifications");
    await waitFor(() => {
      expect(drawer.querySelector('[data-reason="denied"]')).not.toBeNull();
    });
  });

  it("says when there are no notifications", async () => {
    actions.readShellActivity.mockResolvedValue(activity([]));
    const { drawer } = await openDrawer("notifications");
    expect(await within(drawer).findByText("No notifications")).toBeTruthy();
    expect(
      within(drawer).queryByText(/Some notifications are unavailable/),
    ).toBeNull();
  });

  it("names each failed scope, flags a partial list, and renders each notification's parts", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity([], {
        items: [
          notification("n1", {
            unread: true,
            body: "Deploy agent spent past its budget",
            deepLink: "/acme/core-platform/runs/run_42",
          }),
          notification("n2"),
        ],
        partial: true,
        failures: [
          { ws: null, read: fail("error", "org_down") },
          { ws: "edge", read: fail("error", "edge_down") },
        ],
      }),
    );
    const { user, drawer } = await openDrawer("notifications");
    await within(drawer).findByText("Title n1");
    const failures = drawer.querySelectorAll('[data-reason="error"]');
    expect(failures[0]?.textContent).toContain("Notifications could not");
    expect(failures[1]?.textContent).toContain("edge could not");
    expect(
      within(drawer).getByText(/Some notifications are unavailable/),
    ).toBeTruthy();
    const unread = within(drawer).getByText("Title n1").closest("li");
    const read = within(drawer).getByText("Title n2").closest("li");
    if (!unread || !read) throw new Error("notification rows missing");
    expect(unread.textContent).toContain("Deploy agent spent past its budget");
    expect(
      within(unread).getByRole("link", { name: "Open" }).getAttribute("href"),
    ).toBe("/acme/core-platform/runs/run_42");
    expect(within(read).queryByRole("link")).toBeNull();
    expect(
      within(read).queryByRole("button", { name: "Mark read" }),
    ).toBeNull();

    await user.click(within(unread).getByRole("link", { name: "Open" }));
    await waitFor(() => {
      expect(screen.queryByTestId("notifications-drawer")).toBeNull();
    });
  });

  it("marks read and archives through the action, then reads again", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity([], {
        items: [notification("n1", { unread: true })],
        partial: false,
        failures: [],
      }),
    );
    actions.markShellNotification.mockResolvedValue(ok({ ok: true }));
    const { user, drawer } = await openDrawer("notifications");
    await user.click(
      await within(drawer).findByRole("button", { name: "Mark read" }),
    );
    expect(actions.markShellNotification).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "n1",
      false,
    );
    const reads = actions.readShellActivity.mock.calls.length;
    await user.click(within(drawer).getByRole("button", { name: "Archive" }));
    expect(actions.markShellNotification).toHaveBeenLastCalledWith(
      "acme",
      "core-platform",
      "n1",
      true,
    );
    await waitFor(() => {
      expect(actions.readShellActivity.mock.calls.length).toBeGreaterThan(
        reads,
      );
    });
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });

  it.each([
    [
      "the action refuses",
      () => Promise.resolve(fail("denied", "notify.mark")),
    ],
    ["the contract answers not ok", () => Promise.resolve(ok({ ok: false }))],
    ["the action throws", () => Promise.reject(new Error("network"))],
  ])("alerts when %s", async (_case, answer) => {
    actions.readShellActivity.mockResolvedValue(
      activity([], {
        items: [notification("n1")],
        partial: false,
        failures: [],
      }),
    );
    actions.markShellNotification.mockImplementation(answer);
    const { user, drawer } = await openDrawer("notifications");
    await user.click(
      await within(drawer).findByRole("button", { name: "Archive" }),
    );
    expect((await within(drawer).findByRole("alert")).textContent).toBe(
      "Activity could not be refreshed. Try again.",
    );
    expect(
      within(drawer)
        .getByRole("button", { name: "Archive" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});
