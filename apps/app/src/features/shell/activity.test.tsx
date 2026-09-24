// @vitest-environment jsdom
// The shell's organization activity: the topbar's approvals and notification
// badges, which read the idle poll while both drawers are closed and the
// detailed read while one is open, and the two drawers that detailed read
// fills. A detailed value left from an earlier opening never freezes a badge,
// and a read answered after its drawer closed never lands.
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
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
import { IntlProvider } from "@/test/intl";
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
const nav = vi.hoisted(() => ({ pathname: "/acme/core-platform" }));
vi.mock("./activity-actions", () => actions);
// The approval card is Fleet's and has its own tests. This stand-in shows the
// workspace, mandates and clock the drawer hands it, and lets a test resolve.
vi.mock("@/features/fleet/client", () => ({
  ApprovalsPanel: ({
    ws,
    now,
    mandates,
    onResolved,
  }: {
    ws: string;
    now: number;
    mandates: ReadonlyMap<string, unknown>;
    onResolved?: () => void;
  }) => (
    <section aria-label="Approval card">
      <p>{`${ws} with ${String(mandates.size)} mandates at ${new Date(now).toISOString()}`}</p>
      <button
        type="button"
        onClick={() => {
          onResolved?.();
        }}
      >
        Resolve
      </button>
    </section>
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const ok = <T,>(value: T) => ({ ok: true as const, value });
const navCounts = (approvals: number | null) =>
  ok({ approvals, proposals: null, incidents: null });
const unread = (unreadCount: number) => ok({ notifications: [], unreadCount });

const approval = (
  id: string,
  tool: string,
  agentKey: string | null = null,
  runId: string | null = null,
) => ({ id, tool, agentKey, runId });

const workspace = (
  slug: string,
  name: string,
  overrides: Record<string, unknown> = {},
) => ({
  slug,
  name,
  pending: ok({ items: [approval(`apr_${slug}`, "deploy")], more: false }),
  mandates: ok({ mandates: [] }),
  resolved: ok({ items: [], nextCursor: null }),
  ...overrides,
});

const notice = (
  publicId: string,
  overrides: Record<string, unknown> = {},
  ws: string | null = null,
) => ({
  notification: {
    publicId,
    title: `Notice ${publicId}`,
    body: null,
    deepLink: null,
    unread: false,
    createdAt: "2026-09-23T00:00:00Z",
    ...overrides,
  },
  ws,
});

type Notices = {
  items: ReturnType<typeof notice>[];
  partial: boolean;
  failures: unknown[];
};
const NO_NOTICES: Notices = { items: [], partial: false, failures: [] };

const activity = ({
  workspaces = [workspace("core-platform", "Core platform")],
  notifications = NO_NOTICES,
}: {
  workspaces?: ReturnType<typeof workspace>[];
  notifications?: Notices;
} = {}) =>
  ok({
    workspaces,
    notifications,
    currentWorkspace: "core-platform",
    readAt: "2026-09-23T00:00:00.000Z",
  });

/** A promise the test settles by hand, to hold a read in flight. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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
  nav.pathname = "/acme/core-platform";
  actions.readShellNavCounts.mockResolvedValue(navCounts(3));
  actions.readShellUnreadCount.mockResolvedValue(unread(2));
  actions.readShellActivity.mockResolvedValue(activity());
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

function renderButtons(data = shellData()) {
  const tree = (shell: ReturnType<typeof shellData>) => (
    <IntlProvider>
      <ShellStateProvider>
        <ShellActivityProvider data={shell}>
          <ActivityButtons />
          <Opener />
        </ShellActivityProvider>
      </ShellStateProvider>
    </IntlProvider>
  );
  const view = render(tree(data));
  return {
    ...view,
    rerenderWith: (next: ReturnType<typeof shellData>) => {
      view.rerender(tree(next));
    },
  };
}

function renderShell(data = shellData()) {
  return render(
    <IntlProvider>
      <ShellStateProvider>
        <ShellActivityProvider data={data}>
          <ActivityButtons />
          <ActivityDrawers data={data} />
        </ShellActivityProvider>
      </ShellStateProvider>
    </IntlProvider>,
  );
}

/** The topbar's approvals button, behind an open drawer or not. */
const approvalsButton = () =>
  screen.getByRole("button", { name: "Approvals", hidden: true });

async function openApprovals() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Approvals" }));
  return {
    user,
    drawer: await screen.findByRole("dialog", { name: "Approvals" }),
  };
}

async function openNotifications() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Notifications" }));
  return {
    user,
    drawer: await screen.findByRole("dialog", { name: "Notifications" }),
  };
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

  it("render no dot when nothing is unread (negative)", async () => {
    actions.readShellUnreadCount.mockResolvedValue(unread(0));
    renderButtons();
    await waitFor(() => {
      expect(actions.readShellUnreadCount).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
  });

  it.each([
    {
      when: "both idle reads throw",
      counts: () => Promise.reject(new Error("offline")),
      unreadRead: () => Promise.reject(new Error("offline")),
    },
    {
      when: "both idle reads are refused",
      counts: () =>
        Promise.resolve({ ok: false, reason: "denied", code: "approval.read" }),
      unreadRead: () =>
        Promise.resolve({
          ok: false,
          reason: "denied",
          code: "notification.read",
        }),
    },
    {
      when: "the count read carries no approval figure",
      counts: () => Promise.resolve(navCounts(null)),
      unreadRead: () => Promise.resolve(unread(0)),
    },
  ])(
    "show neither a count nor a dot when $when (negative)",
    async ({ counts, unreadRead }) => {
      actions.readShellNavCounts.mockImplementation(counts);
      actions.readShellUnreadCount.mockImplementation(unreadRead);
      const { container } = renderButtons();
      await waitFor(() => {
        expect(actions.readShellUnreadCount).toHaveBeenCalled();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        screen.getByRole("button", { name: "Approvals" }).textContent,
      ).toBe("Approvals");
      expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
      await expectNoAxe(container);
    },
  );

  it("read only the unread count, org-wide, when the viewer has no workspace", async () => {
    nav.pathname = "/acme";
    renderButtons(shellData({ context: readOk({ orgs: [], workspaces: [] }) }));
    expect(await screen.findByLabelText("2 unread notifications")).toBeTruthy();
    expect(actions.readShellUnreadCount).toHaveBeenCalledWith("acme", null);
    expect(actions.readShellNavCounts).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Approvals" }).textContent).toBe(
      "Approvals",
    );
  });

  it("drop the previous organization's figures the moment the scope changes", async () => {
    const view = renderButtons();
    await screen.findByLabelText("2 unread notifications");
    expect(
      screen.getByRole("button", { name: "Approvals" }).textContent,
    ).toContain("3");

    const pendingCounts = deferred<ReturnType<typeof navCounts>>();
    const pendingUnread = deferred<ReturnType<typeof unread>>();
    actions.readShellNavCounts.mockReturnValue(pendingCounts.promise);
    actions.readShellUnreadCount.mockReturnValue(pendingUnread.promise);
    nav.pathname = "/globex/research";
    view.rerenderWith(
      shellData({
        org: { key: "org_globex", slug: "globex", name: "Globex" },
      }),
    );

    await waitFor(() => {
      expect(actions.readShellNavCounts).toHaveBeenCalledWith(
        "globex",
        "research",
      );
    });
    expect(screen.getByRole("button", { name: "Approvals" }).textContent).toBe(
      "Approvals",
    );
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();

    await act(async () => {
      pendingCounts.resolve(navCounts(7));
      pendingUnread.resolve(unread(1));
      await pendingUnread.promise;
    });
    expect(await screen.findByLabelText("1 unread notifications")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approvals" }).textContent,
    ).toContain("7");
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

  it("stop polling once the shell unmounts, even with reads still in flight", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pendingCounts = deferred<ReturnType<typeof navCounts>>();
    const pendingUnread = deferred<ReturnType<typeof unread>>();
    actions.readShellNavCounts.mockReturnValue(pendingCounts.promise);
    actions.readShellUnreadCount.mockReturnValue(pendingUnread.promise);
    const view = renderButtons();
    await waitFor(() => {
      expect(actions.readShellUnreadCount).toHaveBeenCalledTimes(1);
    });

    view.unmount();
    await act(async () => {
      pendingCounts.resolve(navCounts(9));
      pendingUnread.reject(new Error("aborted"));
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(actions.readShellUnreadCount).toHaveBeenCalledTimes(1);
    expect(actions.readShellNavCounts).toHaveBeenCalledTimes(1);
  });

  it("stop polling after an unmount whose idle count read failed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pendingCounts = deferred<ReturnType<typeof navCounts>>();
    actions.readShellNavCounts.mockReturnValue(pendingCounts.promise);
    const view = renderButtons();
    await waitFor(() => {
      expect(actions.readShellNavCounts).toHaveBeenCalledTimes(1);
    });

    view.unmount();
    await act(async () => {
      pendingCounts.reject(new Error("aborted"));
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(actions.readShellNavCounts).toHaveBeenCalledTimes(1);
  });

  it("show no figures outside an activity provider (negative)", async () => {
    const { container } = render(
      <IntlProvider>
        <ShellStateProvider>
          <ActivityButtons />
        </ShellStateProvider>
      </IntlProvider>,
    );
    expect(screen.getByRole("button", { name: "Approvals" }).textContent).toBe(
      "Approvals",
    );
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
    await expectNoAxe(container);
  });
});

describe("the approvals drawer", () => {
  it("says it is loading until the first detailed read answers", async () => {
    const pending = deferred<ReturnType<typeof activity>>();
    actions.readShellActivity.mockReturnValue(pending.promise);
    renderShell();
    const { drawer } = await openApprovals();

    expect(within(drawer).getByRole("status").textContent).toBe(
      "Loading activity",
    );
    await expectNoAxe(document.body);

    await act(async () => {
      pending.resolve(activity());
      await pending.promise;
    });
    expect(within(drawer).queryByRole("status")).toBeNull();
    expect(
      within(drawer).getByRole("heading", { name: "Core platform" }),
    ).toBeTruthy();
  });

  it("lists every workspace's waiting approvals, its failures and today's resolved count", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity({
        workspaces: [
          workspace("core-platform", "Core platform", {
            pending: ok({
              items: [
                approval("apr_1", "deploy_service", "release-bot", "run_1"),
                approval("apr_2", "run_shell", null, "run_2"),
                approval("apr_3", "write_file"),
              ],
              more: false,
            }),
            resolved: ok({ items: [{}, {}], nextCursor: "cur_2" }),
          }),
          workspace("research", "Research", {
            pending: {
              ok: false,
              reason: "denied",
              permission: "approval.read",
            },
            resolved: {
              ok: false,
              reason: "error",
              code: "store_unavailable",
              status: 503,
            },
          }),
          workspace("data", "Data", {
            pending: ok({ items: [], more: false }),
            resolved: ok({ items: [{}], nextCursor: null }),
          }),
          workspace("ops", "Ops", {
            pending: ok({
              items: [approval("apr_4", "rotate_key", "ops-bot")],
              more: true,
            }),
          }),
        ],
      }),
    );
    renderShell();
    const { drawer } = await openApprovals();
    await within(drawer).findByRole("heading", { name: "Core platform" });

    const core = within(drawer).getByRole("heading", {
      name: "Core platform",
    }).parentElement;
    if (!(core instanceof HTMLElement)) throw new Error("no section");
    expect(within(core).getByText("release-bot")).toBeTruthy();
    expect(within(core).getByText("run_2")).toBeTruthy();
    expect(within(core).getByText("apr_3")).toBeTruthy();
    expect(within(core).getByText("2 resolved today (UTC)+")).toBeTruthy();

    expect(
      within(drawer).getByText(
        "You cannot see Research in this workspace. Your roles do not include approval.read; an organization owner can grant it.",
      ),
    ).toBeTruthy();
    expect(
      within(drawer).getByText(
        "Resolved approvals could not be loaded: the control plane answered store_unavailable. Nothing was changed, and runs kept recording.",
      ),
    ).toBeTruthy();
    expect(within(drawer).getByText("No approvals waiting")).toBeTruthy();
    expect(within(drawer).getByText("1 resolved today (UTC)")).toBeTruthy();
    expect(
      within(drawer).getByText(
        "More approvals are waiting than this list can show.",
      ),
    ).toBeTruthy();
    expect(within(drawer).queryByText("No accessible workspaces")).toBeNull();

    // Four waiting approvals are listed; the refused and truncated
    // workspaces mark the total as a floor.
    expect(approvalsButton().textContent).toContain("4+");
    await expectNoAxe(document.body);
  });

  it("opens one approval with its workspace's mandates and returns to the list", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity({
        workspaces: [
          workspace("core-platform", "Core platform", {
            mandates: ok({ mandates: [{ id: "mnd_1" }, { id: "mnd_2" }] }),
          }),
          workspace("research", "Research", {
            pending: ok({
              items: [approval("apr_9", "delete_branch")],
              more: false,
            }),
            mandates: {
              ok: false,
              reason: "denied",
              permission: "mandate.read",
            },
          }),
        ],
      }),
    );
    renderShell();
    const { user, drawer } = await openApprovals();
    await user.click(
      await within(drawer).findByRole("button", { name: /deploy/ }),
    );

    expect(
      within(drawer).getByText(
        "core-platform with 2 mandates at 2026-09-23T00:00:00.000Z",
      ),
    ).toBeTruthy();
    expect(
      within(drawer).queryByRole("heading", { name: "Research" }),
    ).toBeNull();
    await expectNoAxe(document.body);

    await user.click(
      within(drawer).getByRole("button", { name: "All approvals" }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: /delete_branch/ }),
    );
    expect(
      within(drawer).getByText(
        "research with 0 mandates at 2026-09-23T00:00:00.000Z",
      ),
    ).toBeTruthy();
  });

  it("re-reads the activity when an opened approval is resolved or Refresh is pressed", async () => {
    renderShell();
    const { user, drawer } = await openApprovals();
    await user.click(
      await within(drawer).findByRole("button", { name: /deploy/ }),
    );
    expect(actions.readShellActivity).toHaveBeenCalledTimes(1);

    await user.click(within(drawer).getByRole("button", { name: "Resolve" }));
    await waitFor(() => {
      expect(actions.readShellActivity).toHaveBeenCalledTimes(2);
    });

    await user.click(within(drawer).getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(actions.readShellActivity).toHaveBeenCalledTimes(3);
    });
  });

  it("says there are no accessible workspaces when the read holds none (negative)", async () => {
    actions.readShellActivity.mockResolvedValue(activity({ workspaces: [] }));
    renderShell();
    const { drawer } = await openApprovals();
    expect(
      await within(drawer).findByText("No accessible workspaces"),
    ).toBeTruthy();
    expect(approvalsButton().textContent).toContain("0");
    await expectNoAxe(document.body);
  });

  it.each([
    {
      reason: "denied",
      read: { ok: false, reason: "denied", code: "approval.read" },
      text: "You cannot see Approvals in this workspace. Your roles do not include approval.read; an organization owner can grant it.",
    },
    {
      reason: "pending_approval",
      read: { ok: false, reason: "pending_approval", accessRequestId: "acr_7" },
      text: "Access to Approvals is waiting for approval, request acr_7.",
    },
    {
      reason: "unavailable",
      read: { ok: false, reason: "unavailable", code: "kernel_down" },
      text: "Approvals could not be loaded: the control plane answered kernel_down. Nothing was changed, and runs kept recording.",
    },
  ])(
    "explains a refused detailed read ($reason) in place of the list (negative)",
    async ({ read, text }) => {
      actions.readShellActivity.mockResolvedValue(read);
      renderShell();
      const { drawer } = await openApprovals();
      expect(await within(drawer).findByText(text)).toBeTruthy();
      // A refused detailed read leaves the badge on the idle count.
      expect(approvalsButton().textContent).toContain("3");
      await expectNoAxe(document.body);
    },
  );

  it("alerts when the read throws and clears the alert once a refresh succeeds (negative)", async () => {
    actions.readShellActivity.mockRejectedValueOnce(new Error("network"));
    renderShell();
    const { user, drawer } = await openApprovals();
    expect((await within(drawer).findByRole("alert")).textContent).toBe(
      "Activity could not be refreshed. Try again.",
    );
    await expectNoAxe(document.body);

    await user.click(within(drawer).getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(within(drawer).queryByRole("alert")).toBeNull();
    });
    expect(
      within(drawer).getByRole("heading", { name: "Core platform" }),
    ).toBeTruthy();
  });

  it("ignores a read that answers after its drawer closed", async () => {
    const first = deferred<ReturnType<typeof activity>>();
    const second = deferred<ReturnType<typeof activity>>();
    actions.readShellActivity
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(
        activity({ workspaces: [workspace("current", "Current")] }),
      );
    renderShell();

    for (let i = 0; i < 2; i += 1) {
      const { user, drawer } = await openApprovals();
      expect(within(drawer).getByRole("status").textContent).toBe(
        "Loading activity",
      );
      await user.click(within(drawer).getByRole("button", { name: "Close" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
    }

    const { drawer } = await openApprovals();
    await within(drawer).findByRole("heading", { name: "Current" });
    await act(async () => {
      second.resolve(activity({ workspaces: [workspace("stale", "Stale")] }));
      first.reject(new Error("late"));
      await second.promise;
    });
    expect(within(drawer).queryByRole("heading", { name: "Stale" })).toBeNull();
    expect(within(drawer).queryByRole("alert")).toBeNull();
    expect(actions.readShellActivity).toHaveBeenCalledTimes(3);
  });

  it("keeps the open drawer current with a read every 30 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderShell();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Approvals" }));
    await waitFor(() => {
      expect(actions.readShellActivity).toHaveBeenCalledTimes(1);
    });
    actions.readShellActivity.mockResolvedValue(
      activity({ workspaces: [workspace("later", "Later")] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(actions.readShellActivity).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("heading", { name: "Later" })).toBeTruthy();
  });
});

describe("the notifications drawer", () => {
  const withNotices = () =>
    activity({
      notifications: {
        items: [
          notice(
            "ntf_1",
            {
              title: "Budget reached",
              body: "The release agent spent its weekly budget.",
              deepLink: "/acme/core-platform/spend",
              unread: true,
            },
            "core-platform",
          ),
          notice("ntf_2", { title: "Mandate updated" }),
        ],
        partial: true,
        failures: [
          {
            ws: null,
            read: {
              ok: false,
              reason: "error",
              code: "notifications_down",
              status: 503,
            },
          },
          {
            ws: "research",
            read: {
              ok: false,
              reason: "denied",
              permission: "notification.read",
            },
          },
        ],
      },
    });

  it("lists the notifications with their failures, partial note and unread dot", async () => {
    actions.readShellActivity.mockResolvedValue(withNotices());
    renderShell();
    const { drawer } = await openNotifications();

    expect(
      await within(drawer).findByRole("heading", { name: "Budget reached" }),
    ).toBeTruthy();
    expect(
      within(drawer).getByText("The release agent spent its weekly budget."),
    ).toBeTruthy();
    expect(
      within(drawer).getByRole("link", { name: "Open" }).getAttribute("href"),
    ).toBe("/acme/core-platform/spend");
    expect(
      within(drawer).getAllByRole("button", { name: "Mark read" }),
    ).toHaveLength(1);
    expect(
      within(drawer).getAllByRole("button", { name: "Archive" }),
    ).toHaveLength(2);
    expect(
      within(drawer).getByText(
        "Notifications could not be loaded: the control plane answered notifications_down. Nothing was changed, and runs kept recording.",
      ),
    ).toBeTruthy();
    expect(
      within(drawer).getByText(
        "You cannot see research in this workspace. Your roles do not include notification.read; an organization owner can grant it.",
      ),
    ).toBeTruthy();
    expect(
      within(drawer).getByText(
        "Some notifications are unavailable or outside this page. Counts cover the loaded records.",
      ),
    ).toBeTruthy();
    // The open drawer's read, not the idle poll's 2, decides the dot.
    expect(screen.getByLabelText("1 unread notifications")).toBeTruthy();
    await expectNoAxe(document.body);
  });

  it("closes itself when a notification's link is followed", async () => {
    actions.readShellActivity.mockResolvedValue(withNotices());
    renderShell();
    const { user, drawer } = await openNotifications();
    await user.click(await within(drawer).findByRole("link", { name: "Open" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("marks one read and archives another in the workspace each came from, then re-reads", async () => {
    actions.readShellActivity.mockResolvedValue(withNotices());
    actions.markShellNotification.mockResolvedValue(ok(ok({})));
    renderShell();
    const { user, drawer } = await openNotifications();

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
      expect(actions.readShellActivity).toHaveBeenCalledTimes(2);
    });

    const archive = within(drawer).getAllByRole("button", { name: "Archive" });
    const second = archive[1];
    if (!(second instanceof HTMLElement)) throw new Error("no second archive");
    await user.click(second);
    expect(actions.markShellNotification).toHaveBeenLastCalledWith(
      "acme",
      null,
      "ntf_2",
      true,
    );
    await waitFor(() => {
      expect(actions.readShellActivity).toHaveBeenCalledTimes(3);
    });
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });

  it("disables every mark button while one mark is in flight", async () => {
    actions.readShellActivity.mockResolvedValue(withNotices());
    const pending = deferred<ReturnType<typeof ok>>();
    actions.markShellNotification.mockReturnValue(pending.promise);
    renderShell();
    const { user, drawer } = await openNotifications();

    await user.click(
      await within(drawer).findByRole("button", { name: "Mark read" }),
    );
    for (const button of within(drawer).getAllByRole("button", {
      name: /Mark read|Archive/,
    }))
      expect(button.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      pending.resolve(ok({ ok: true, value: {} }));
      await pending.promise;
    });
    await waitFor(() => {
      expect(
        within(drawer)
          .getByRole("button", { name: "Mark read" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
  });

  it.each([
    {
      when: "the write is refused",
      answer: () =>
        Promise.resolve({ ok: false, reason: "denied", code: "notify.write" }),
    },
    {
      when: "the store reports it did not apply",
      answer: () => Promise.resolve(ok({ ok: false, reason: "not_found" })),
    },
    {
      when: "the write throws",
      answer: () => Promise.reject(new Error("network")),
    },
  ])(
    "alerts when $when and does not re-read (negative)",
    async ({ answer }) => {
      actions.readShellActivity.mockResolvedValue(withNotices());
      actions.markShellNotification.mockImplementation(answer);
      renderShell();
      const { user, drawer } = await openNotifications();

      await user.click(
        await within(drawer).findByRole("button", { name: "Mark read" }),
      );
      expect((await within(drawer).findByRole("alert")).textContent).toBe(
        "Activity could not be refreshed. Try again.",
      );
      expect(actions.readShellActivity).toHaveBeenCalledTimes(1);
      await expectNoAxe(document.body);
    },
  );

  it("says there are no notifications when the read holds none (negative)", async () => {
    renderShell();
    const { drawer } = await openNotifications();
    expect(await within(drawer).findByText("No notifications")).toBeTruthy();
    expect(within(drawer).queryByRole("listitem")).toBeNull();
    await expectNoAxe(document.body);
  });

  it("says it is loading until the first detailed read answers", async () => {
    actions.readShellActivity.mockReturnValue(new Promise(() => undefined));
    renderShell();
    const { drawer } = await openNotifications();
    expect(within(drawer).getByRole("status").textContent).toBe(
      "Loading activity",
    );
  });
});
