// @vitest-environment jsdom
// The topbar's approvals and notification badges while both drawers are
// closed: they read the idle poll, never the drawer's read across every
// workspace, and a detailed value left from an earlier opening does not freeze
// them.
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
vi.mock("@/features/fleet/client", () => ({ ApprovalsPanel: () => null }));
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

const failedRead = (code: string) => ({
  ok: false as const,
  reason: "error" as const,
  code,
  status: 503,
});

/** Three workspaces: one with approvals waiting, one whose reads failed, one with nothing. */
const ACTIVITY = ok({
  workspaces: [
    {
      slug: "core-platform",
      name: "Core platform",
      pending: ok({
        items: [
          {
            id: "apr_1",
            tool: "github__merge",
            agentKey: null,
            runId: "arun_1",
          },
          { id: "apr_2", tool: "shell__exec", agentKey: null, runId: null },
        ],
        more: true,
      }),
      mandates: ok({ mandates: [{ id: "mdt_1" }] }),
      resolved: ok({ items: [{ id: "r1" }], nextCursor: "c_2" }),
    },
    {
      slug: "docs",
      name: "Docs",
      pending: failedRead("approvals_down"),
      mandates: failedRead("mandates_down"),
      resolved: failedRead("resolved_down"),
    },
    {
      slug: "ops",
      name: "Ops",
      pending: ok({ items: [], more: false }),
      mandates: ok({ mandates: [] }),
      resolved: ok({ items: [], nextCursor: null }),
    },
  ],
  notifications: {
    items: [
      {
        ws: "core-platform",
        notification: {
          publicId: "ntf_1",
          title: "A run was held",
          body: "arun_1 waits on an approval.",
          deepLink: "/acme/core-platform/runs/arun_1",
          unread: true,
          createdAt: "2026-09-23T00:00:00Z",
        },
      },
      {
        ws: null,
        notification: {
          publicId: "ntf_2",
          title: "Invoice ready",
          body: null,
          deepLink: null,
          unread: false,
          createdAt: "2026-09-22T00:00:00Z",
        },
      },
    ],
    partial: true,
    failures: [
      { ws: null, read: failedRead("org_notifications_down") },
      { ws: "docs", read: failedRead("docs_notifications_down") },
    ],
  },
  currentWorkspace: "core-platform",
  readAt: "2026-09-23T00:00:00Z",
});

function renderDrawers() {
  return render(
    <IntlProvider>
      <ShellStateProvider>
        <ShellActivityProvider data={shellData()}>
          <ActivityButtons />
          <ActivityDrawers data={shellData()} />
        </ShellActivityProvider>
      </ShellStateProvider>
    </IntlProvider>,
  );
}

async function openDrawer(name: "Approvals" | "Notifications") {
  const user = userEvent.setup();
  renderDrawers();
  await user.click(screen.getByRole("button", { name }));
  const drawer = await screen.findByTestId(
    name === "Approvals" ? "approvals-drawer" : "notifications-drawer",
  );
  return { user, drawer };
}

describe("the approvals drawer", () => {
  beforeEach(() => {
    actions.readShellActivity.mockResolvedValue(ACTIVITY);
  });

  it("lists each workspace's approvals, says which read failed, which has none and that more are waiting", async () => {
    const { drawer } = await openDrawer("Approvals");
    await within(drawer).findByText("github__merge");
    // An approval with no agent names its run, and one with neither names itself.
    expect(drawer).toHaveTextContent("arun_1");
    expect(drawer).toHaveTextContent("apr_2");
    expect(drawer).toHaveTextContent(
      "More approvals are waiting than this list can show.",
    );
    expect(drawer).toHaveTextContent("1 resolved today (UTC)+");
    expect(drawer).toHaveTextContent(
      "Docs could not be loaded: the control plane answered approvals_down.",
    );
    expect(drawer).toHaveTextContent("resolved_down");
    expect(drawer).toHaveTextContent("No approvals waiting");
    // The badge counts what it read and says the list was cut short. The
    // modal drawer hides the topbar from the accessibility tree.
    expect(
      screen.getByRole("button", { name: "Approvals", hidden: true })
        .textContent,
    ).toContain("2+");
  });

  it("opens one approval and goes back to all of them, and re-reads on Refresh", async () => {
    const { user, drawer } = await openDrawer("Approvals");
    await user.click(await within(drawer).findByText("github__merge"));
    expect(
      within(drawer).getByRole("button", { name: "All approvals" }),
    ).toBeTruthy();
    expect(within(drawer).queryByText("shell__exec")).toBeNull();
    await user.click(
      within(drawer).getByRole("button", { name: "All approvals" }),
    );
    expect(within(drawer).getByText("shell__exec")).toBeTruthy();
    const reads = actions.readShellActivity.mock.calls.length;
    await user.click(within(drawer).getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(actions.readShellActivity.mock.calls.length).toBe(reads + 1);
    });
  });

  it("says there is no workspace to read when the viewer can see none", async () => {
    actions.readShellActivity.mockResolvedValue(
      ok({
        workspaces: [],
        notifications: { items: [], partial: false, failures: [] },
        currentWorkspace: null,
        readAt: "2026-09-23T00:00:00Z",
      }),
    );
    const { drawer } = await openDrawer("Approvals");
    expect(
      await within(drawer).findByText("No accessible workspaces"),
    ).toBeTruthy();
  });

  it.each([
    [
      { ok: false, reason: "denied", code: "approval.read" },
      "Your roles do not include approval.read",
    ],
    [
      { ok: false, reason: "pending_approval", accessRequestId: "acr_7" },
      "waiting for approval, request acr_7",
    ],
    [
      { ok: false, reason: "unavailable", code: "shell_down" },
      "the control plane answered shell_down",
    ],
  ] as const)(
    "prints the activity read's refusal %o in its own words (negative)",
    async (refusal, sentence) => {
      actions.readShellActivity.mockResolvedValue(refusal);
      const { drawer } = await openDrawer("Approvals");
      await waitFor(() => {
        expect(drawer).toHaveTextContent(sentence);
      });
    },
  );

  it("says it is loading until the read answers, and that it could not refresh when the read throws (negative)", async () => {
    let fail!: (reason: unknown) => void;
    actions.readShellActivity.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const { drawer } = await openDrawer("Approvals");
    expect(within(drawer).getByRole("status")).toHaveTextContent(
      "Loading activity",
    );
    await act(async () => {
      fail(new Error("offline"));
      await Promise.resolve();
    });
    expect(await within(drawer).findByRole("alert")).toHaveTextContent(
      "Activity could not be refreshed. Try again.",
    );
  });

  it("drops an answer that lands after the drawer closed", async () => {
    let answer!: (value: unknown) => void;
    actions.readShellActivity.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { user, drawer } = await openDrawer("Approvals");
    await user.click(within(drawer).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByTestId("approvals-drawer")).toBeNull();
    });
    await act(async () => {
      answer(ACTIVITY);
      await Promise.resolve();
    });
    // Reopen with the next read still in flight: had the closed drawer's
    // answer landed, its approvals would show at once instead of Loading.
    actions.readShellActivity.mockReturnValue(new Promise(() => {}));
    await user.click(screen.getByRole("button", { name: "Approvals" }));
    const reopened = await screen.findByTestId("approvals-drawer");
    expect(within(reopened).getByRole("status")).toHaveTextContent(
      "Loading activity",
    );
    expect(within(reopened).queryByText("github__merge")).toBeNull();
  });
});

describe("the notifications drawer", () => {
  beforeEach(() => {
    actions.readShellActivity.mockResolvedValue(ACTIVITY);
  });

  it("lists each notification with its body and link, marks the unread one, and says which reads failed", async () => {
    const { drawer } = await openDrawer("Notifications");
    await within(drawer).findByText("A run was held");
    expect(drawer).toHaveTextContent("arun_1 waits on an approval.");
    expect(within(drawer).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/arun_1",
    );
    // Only the unread notification offers Mark read; both offer Archive.
    expect(
      within(drawer).getAllByRole("button", { name: "Mark read" }),
    ).toHaveLength(1);
    expect(
      within(drawer).getAllByRole("button", { name: "Archive" }),
    ).toHaveLength(2);
    expect(drawer).toHaveTextContent("org_notifications_down");
    expect(drawer).toHaveTextContent("docs_notifications_down");
    expect(drawer).toHaveTextContent(
      "Some notifications are unavailable or outside this page.",
    );
    // The open drawer's read drives the unread dot.
    expect(screen.getByLabelText("1 unread notifications")).toBeTruthy();
  });

  it("marks a notification read in its own workspace and re-reads the drawer", async () => {
    actions.markShellNotification.mockResolvedValue(ok({ ok: true }));
    const { user, drawer } = await openDrawer("Notifications");
    await user.click(
      await within(drawer).findByRole("button", { name: "Mark read" }),
    );
    expect(actions.markShellNotification).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "ntf_1",
      false,
    );
    await waitFor(() => {
      expect(
        actions.readShellActivity.mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });

  it.each([
    [
      "refused",
      () =>
        actions.markShellNotification.mockResolvedValue(
          failedRead("mark_down"),
        ),
    ],
    [
      "not applied",
      () => actions.markShellNotification.mockResolvedValue(ok({ ok: false })),
    ],
    [
      "thrown",
      () =>
        actions.markShellNotification.mockRejectedValue(new Error("offline")),
    ],
  ] as const)(
    "says it could not refresh when archiving is %s (negative)",
    async (_case, arrange) => {
      arrange();
      const { user, drawer } = await openDrawer("Notifications");
      const [archive] = await within(drawer).findAllByRole("button", {
        name: "Archive",
      });
      if (archive === undefined) throw new Error("no Archive");
      await user.click(archive);
      expect(await within(drawer).findByRole("alert")).toHaveTextContent(
        "Activity could not be refreshed. Try again.",
      );
    },
  );

  it("closes itself when a notification's link is followed", async () => {
    const { user, drawer } = await openDrawer("Notifications");
    await user.click(await within(drawer).findByRole("link", { name: "Open" }));
    await waitFor(() => {
      expect(screen.queryByTestId("notifications-drawer")).toBeNull();
    });
  });

  it("says there are no notifications when the read holds none", async () => {
    actions.readShellActivity.mockResolvedValue(
      ok({
        workspaces: [],
        notifications: { items: [], partial: false, failures: [] },
        currentWorkspace: "core-platform",
        readAt: "2026-09-23T00:00:00Z",
      }),
    );
    const { drawer } = await openDrawer("Notifications");
    expect(await within(drawer).findByText("No notifications")).toBeTruthy();
  });
});

describe("the idle poll", () => {
  it("drops answers that land after the shell unmounted, and a count read that throws", async () => {
    let answer!: (value: unknown) => void;
    actions.readShellUnreadCount.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    actions.readShellNavCounts.mockRejectedValue(new Error("offline"));
    const view = renderButtons();
    view.unmount();
    await act(async () => {
      answer(unread(9));
      await Promise.resolve();
    });
    expect(screen.queryByLabelText("9 unread notifications")).toBeNull();
  });

  it("shows no count when the reads are refused or throw (negative)", async () => {
    actions.readShellUnreadCount.mockResolvedValue(failedRead("unread_down"));
    actions.readShellNavCounts.mockRejectedValue(new Error("offline"));
    renderButtons();
    await waitFor(() => {
      expect(actions.readShellUnreadCount).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Approvals" }).textContent,
    ).not.toMatch(/\d/);

    cleanup();
    actions.readShellUnreadCount.mockRejectedValue(new Error("offline"));
    renderButtons();
    await waitFor(() => {
      expect(actions.readShellUnreadCount).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
  });
});
