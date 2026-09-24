// @vitest-environment jsdom
// The shell's activity: the topbar's approvals and notification badges, the
// provider's idle and drawer polls behind them, and the two drawers they open.
// While both drawers are closed the badges read the idle poll, never the
// drawer's read across every workspace, and a detailed value left from an
// earlier opening does not freeze them. An open drawer keeps its detailed read
// current, renders each read's refusal where it happened, and marks or
// archives a notification in the scope it was read from.
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
import type { ComponentProps, MouseEvent, ReactNode } from "react";
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
import type { ApprovalsPanel as RealApprovalsPanel } from "@/features/fleet/client";
import { expectNoAxe } from "@/test/expect-no-axe";
import shellMessages from "../../../messages/shell.json";
import uiMessages from "../../../messages/ui.json";
import {
  ActivityButtons,
  ActivityDrawers,
  ShellActivityProvider,
} from "./activity";
import { shellData } from "./shell.builders";
import { ShellStateProvider, useShellState } from "./shell-state";

type PanelProps = ComponentProps<typeof RealApprovalsPanel>;

const actions = vi.hoisted(() => ({
  readShellActivity: vi.fn(),
  readShellNavCounts: vi.fn(),
  readShellUnreadCount: vi.fn(),
  markShellNotification: vi.fn(),
}));
vi.mock("./activity-actions", () => actions);

// The Fleet panel is its own lane's component with its own tests; here it is
// the seam the drawer hands one approval to, so it records what it was given.
const panel = vi.hoisted(() => {
  const calls: PanelProps[] = [];
  return { calls };
});
vi.mock("@/features/fleet/client", () => ({
  ApprovalsPanel: (props: PanelProps) => {
    panel.calls.push(props);
    return "Approval detail";
  },
}));

const nav = vi.hoisted(() => ({ pathname: "/acme/core-platform" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
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

const ok = <T,>(value: T) => ({ ok: true as const, value });
const navCounts = (approvals: number | null) =>
  ok({ approvals, proposals: null, incidents: null });
const unread = (unreadCount: number) => ok({ notifications: [], unreadCount });

type PendingItem = {
  id: string;
  tool: string;
  agentKey: string | null;
  runId: string | null;
};
const pendingItem = (overrides: Partial<PendingItem> = {}): PendingItem => ({
  id: "apr_1",
  tool: "deploy_service",
  agentKey: "release-bot",
  runId: "run_1",
  ...overrides,
});

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    slug: "core-platform",
    name: "Core platform",
    pending: ok({ items: [pendingItem()], more: false }),
    mandates: ok({ mandates: [] }),
    resolved: ok({ items: [], nextCursor: null }),
    ...overrides,
  };
}

type Notice = {
  publicId: string;
  title: string;
  body: string | null;
  deepLink: string | null;
  unread: boolean;
  createdAt: string;
};
function notice(overrides: Partial<Notice> = {}, ws: string | null = null) {
  return {
    notification: {
      publicId: "ntf_1",
      title: "Budget reached",
      body: null,
      deepLink: null,
      unread: false,
      createdAt: "2026-09-23T00:00:00Z",
      ...overrides,
    },
    ws,
  };
}

function activity({
  workspaces = [workspace()],
  notifications = {},
}: {
  workspaces?: ReturnType<typeof workspace>[];
  notifications?: Record<string, unknown>;
} = {}) {
  return ok({
    workspaces,
    notifications: {
      items: [],
      partial: false,
      failures: [],
      ...notifications,
    },
    currentWorkspace: "core-platform",
    readAt: "2026-09-23T00:00:00Z",
  });
}

/** A promise the test settles by hand, to hold a read in flight. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
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
  panel.calls.length = 0;
  nav.pathname = "/acme/core-platform";
  actions.readShellNavCounts.mockResolvedValue(navCounts(3));
  actions.readShellUnreadCount.mockResolvedValue(unread(2));
  actions.readShellActivity.mockResolvedValue(
    activity({
      workspaces: [
        workspace({ pending: ok({ items: [{ id: "a" }], more: false }) }),
      ],
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

const messages = { ...shellMessages, ...uiMessages };

/**
 * The provider with the topbar buttons, and either the test's own open and
 * close switch or the real drawers. Not both: an open drawer is modal and
 * makes everything behind it inert, the switch included.
 */
function tree(data = shellData(), drawers = false) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <ShellStateProvider>
        <ShellActivityProvider data={data}>
          <ActivityButtons />
          {drawers ? <ActivityDrawers data={data} /> : <Opener />}
        </ShellActivityProvider>
      </ShellStateProvider>
    </NextIntlClientProvider>
  );
}

function renderButtons(data = shellData()) {
  return render(tree(data));
}

function renderShell(data = shellData()) {
  return render(tree(data, true));
}

const approvalsButton = () => screen.getByRole("button", { name: "Approvals" });

async function openApprovals(user: ReturnType<typeof userEvent.setup>) {
  await user.click(approvalsButton());
  return screen.findByTestId("approvals-drawer");
}

async function closeDrawer(
  user: ReturnType<typeof userEvent.setup>,
  drawer: HTMLElement,
) {
  await user.click(within(drawer).getByRole("button", { name: "Close" }));
  await waitFor(() => {
    expect(drawer.isConnected).toBe(false);
  });
}

async function openNotifications(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Notifications" }));
  return screen.findByTestId("notifications-drawer");
}

describe("activity badges with the drawers closed", () => {
  it("show the idle approval count and unread dot without the detailed read", async () => {
    const { container } = renderButtons();
    expect(await screen.findByLabelText("2 unread notifications")).toBeTruthy();
    expect(approvalsButton().textContent).toContain("3");
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
      expect(approvalsButton().textContent).toContain("1");
    });

    await user.click(screen.getByRole("button", { name: "close drawer" }));
    await waitFor(() => {
      expect(approvalsButton().textContent).toContain("3");
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
    expect(approvalsButton().textContent).toContain("4");
    expect(actions.readShellActivity).not.toHaveBeenCalled();
  });

  it.each([
    [
      "is refused",
      () => ({ ok: false, reason: "denied", code: "approvals.read" }),
    ],
    ["carries no approval count", () => navCounts(null)],
  ])(
    "show no approval count when the idle count read %s",
    async (_, answer) => {
      actions.readShellNavCounts.mockResolvedValue(answer());
      renderButtons();
      await screen.findByLabelText("2 unread notifications");
      expect(approvalsButton().textContent).not.toMatch(/\d/);
    },
  );

  it("show no approval count when the idle count read throws", async () => {
    actions.readShellNavCounts.mockRejectedValue(new Error("network"));
    renderButtons();
    await screen.findByLabelText("2 unread notifications");
    expect(approvalsButton().textContent).not.toMatch(/\d/);
  });

  it("show no unread dot when the unread read is refused", async () => {
    actions.readShellUnreadCount.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "notifications.read",
    });
    renderButtons();
    await waitFor(() => {
      expect(approvalsButton().textContent).toContain("3");
    });
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
  });

  it("clear the unread dot when a later unread read throws", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderButtons();
    await screen.findByLabelText("2 unread notifications");
    actions.readShellUnreadCount.mockRejectedValue(new Error("network"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await waitFor(() => {
      expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
    });
  });

  it("read only the organization's unread count outside any workspace", async () => {
    nav.pathname = "/acme";
    renderButtons(
      shellData({
        context: readOk({ orgs: [shellData().org], workspaces: [] }),
      }),
    );
    expect(await screen.findByLabelText("2 unread notifications")).toBeTruthy();
    expect(actions.readShellUnreadCount).toHaveBeenCalledWith("acme", null);
    expect(actions.readShellNavCounts).not.toHaveBeenCalled();
    expect(approvalsButton().textContent).not.toMatch(/\d/);
  });

  it("hide the previous workspace's counts until the next workspace's reads answer", async () => {
    const { rerender } = renderButtons();
    await screen.findByLabelText("2 unread notifications");
    expect(approvalsButton().textContent).toContain("3");

    const counts = deferred<unknown>();
    const unreadRead = deferred<unknown>();
    actions.readShellNavCounts.mockReturnValue(counts.promise);
    actions.readShellUnreadCount.mockReturnValue(unreadRead.promise);
    nav.pathname = "/acme/billing-ops";
    rerender(tree());

    await waitFor(() => {
      expect(actions.readShellNavCounts).toHaveBeenLastCalledWith(
        "acme",
        "billing-ops",
      );
    });
    expect(approvalsButton().textContent).not.toMatch(/\d/);
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();

    await act(async () => {
      counts.resolve(navCounts(7));
      unreadRead.resolve(unread(1));
      await Promise.resolve();
    });
    expect(await screen.findByLabelText("1 unread notifications")).toBeTruthy();
    expect(approvalsButton().textContent).toContain("7");
  });

  it("stop polling once the shell unmounts, dropping reads that answer after it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const counts = deferred<unknown>();
    const unreadRead = deferred<unknown>();
    actions.readShellNavCounts.mockReturnValue(counts.promise);
    actions.readShellUnreadCount.mockReturnValue(unreadRead.promise);
    const { unmount } = renderButtons();
    await waitFor(() => {
      expect(actions.readShellUnreadCount).toHaveBeenCalledTimes(1);
    });
    unmount();
    await act(async () => {
      counts.resolve(navCounts(9));
      unreadRead.resolve(unread(9));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(actions.readShellUnreadCount).toHaveBeenCalledTimes(1);
    expect(actions.readShellNavCounts).toHaveBeenCalledTimes(1);
  });

  it("stop polling after unmount when the idle reads fail late", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const counts = deferred<unknown>();
    const unreadRead = deferred<unknown>();
    actions.readShellNavCounts.mockReturnValue(counts.promise);
    actions.readShellUnreadCount.mockReturnValue(unreadRead.promise);
    const { unmount } = renderButtons();
    await waitFor(() => {
      expect(actions.readShellUnreadCount).toHaveBeenCalledTimes(1);
    });
    unmount();
    await act(async () => {
      counts.reject(new Error("network"));
      unreadRead.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(actions.readShellUnreadCount).toHaveBeenCalledTimes(1);
  });
});

describe("activity badges without the activity provider", () => {
  it("render both buttons with no count and no dot", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ShellStateProvider>
          <ActivityButtons />
        </ShellStateProvider>
      </NextIntlClientProvider>,
    );
    expect(approvalsButton().textContent).toBe("Approvals");
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
  });
});

describe("activity badges with a drawer open", () => {
  it("count every workspace's pending approvals and mark an incomplete queue with a plus", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity({
        workspaces: [
          workspace({
            pending: ok({
              items: [pendingItem(), pendingItem({ id: "apr_2" })],
              more: false,
            }),
          }),
          workspace({
            slug: "billing-ops",
            name: "Billing ops",
            pending: {
              ok: false,
              reason: "denied",
              permission: "approvals.read",
            },
          }),
        ],
        notifications: {
          items: [
            notice({ publicId: "ntf_1", unread: true }),
            notice({ publicId: "ntf_2", unread: false }),
            notice({ publicId: "ntf_3", unread: true }),
          ],
        },
      }),
    );
    actions.readShellUnreadCount.mockResolvedValue(unread(5));
    const user = userEvent.setup();
    renderButtons();
    await screen.findByLabelText("5 unread notifications");
    await user.click(screen.getByRole("button", { name: "open drawer" }));
    await waitFor(() => {
      expect(approvalsButton().textContent).toContain("2+");
    });
    // Two of the three loaded notifications are unread, not the idle poll's 2
    // by coincidence: the idle poll is set to 5 here.
    expect(screen.getByLabelText("2 unread notifications")).toBeTruthy();
  });

  it("mark a queue with more waiting than it returned with a plus", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity({
        workspaces: [
          workspace({ pending: ok({ items: [pendingItem()], more: true }) }),
        ],
      }),
    );
    const user = userEvent.setup();
    renderButtons();
    await screen.findByLabelText("2 unread notifications");
    await user.click(screen.getByRole("button", { name: "open drawer" }));
    await waitFor(() => {
      expect(approvalsButton().textContent).toContain("1+");
    });
  });
});

describe("approvals drawer", () => {
  it("shows a loading status until the detailed read answers", async () => {
    const read = deferred<unknown>();
    actions.readShellActivity.mockReturnValue(read.promise);
    const user = userEvent.setup();
    renderShell();
    const drawer = await openApprovals(user);
    expect(within(drawer).getByRole("status").textContent).toBe(
      "Loading activity",
    );
    await expectNoAxe(document.body);

    await act(async () => {
      read.resolve(activity());
      await Promise.resolve();
    });
    expect(await within(drawer).findByText("Core platform")).toBeTruthy();
    expect(within(drawer).queryByRole("status")).toBeNull();
  });

  it("names the permission the viewer lacks when the detailed read is denied", async () => {
    actions.readShellActivity.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "approvals.read",
    });
    const user = userEvent.setup();
    renderShell();
    const drawer = await openApprovals(user);
    const failure = await within(drawer).findByText(/approvals\.read/);
    expect(failure.textContent).toBe(
      "You cannot see Approvals in this workspace. Your roles do not include approvals.read; an organization owner can grant it.",
    );
    expect(failure.getAttribute("data-reason")).toBe("denied");
  });

  it("names the access request when access is waiting for approval", async () => {
    actions.readShellActivity.mockResolvedValue({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "req_42",
    });
    const user = userEvent.setup();
    renderShell();
    const drawer = await openApprovals(user);
    expect((await within(drawer).findByText(/req_42/)).textContent).toBe(
      "Access to Approvals is waiting for approval, request req_42.",
    );
  });

  it.each([
    ["unavailable", "shell_unavailable"],
    ["exhausted", "budget_exceeded"],
  ])("reports a %s refusal as an error with its code", async (reason, code) => {
    actions.readShellActivity.mockResolvedValue({ ok: false, reason, code });
    const user = userEvent.setup();
    renderShell();
    const drawer = await openApprovals(user);
    const failure = await within(drawer).findByText(new RegExp(code));
    expect(failure.textContent).toBe(
      `Approvals could not be loaded: the control plane answered ${code}. Nothing was changed, and runs kept recording.`,
    );
    expect(failure.getAttribute("data-reason")).toBe("error");
  });

  it("lists pending approvals by agent, then run, then id, with today's resolved count", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity({
        workspaces: [
          workspace({
            pending: ok({
              items: [
                pendingItem({ id: "apr_1", tool: "deploy_service" }),
                pendingItem({ id: "apr_2", tool: "merge_pr", agentKey: null }),
                pendingItem({
                  id: "apr_3",
                  tool: "push_branch",
                  agentKey: null,
                  runId: null,
                }),
              ],
              more: false,
            }),
            resolved: ok({ items: [{}, {}], nextCursor: "cur_1" }),
          }),
        ],
      }),
    );
    const user = userEvent.setup();
    renderShell();
    const drawer = await openApprovals(user);
    const list = within(await within(drawer).findByRole("list"));
    expect(list.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "deploy_servicerelease-bot",
      "merge_prrun_1",
      "push_branchapr_3",
    ]);
    expect(within(drawer).getByText("2 resolved today (UTC)+")).toBeTruthy();
    expect(within(drawer).queryByText(/More approvals are waiting/)).toBeNull();
    await expectNoAxe(document.body);
  });

  it("shows each workspace's own refusal, empty queue and truncated queue", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity({
        workspaces: [
          workspace({
            slug: "core-platform",
            name: "Core platform",
            pending: {
              ok: false,
              reason: "denied",
              permission: "approvals.read",
            },
          }),
          workspace({
            slug: "billing-ops",
            name: "Billing ops",
            pending: ok({ items: [], more: false }),
            resolved: {
              ok: false,
              reason: "error",
              code: "resolved_unavailable",
              status: 503,
            },
          }),
          workspace({
            slug: "research",
            name: "Research",
            pending: ok({ items: [pendingItem()], more: true }),
            resolved: ok({ items: [{}], nextCursor: null }),
          }),
        ],
      }),
    );
    const user = userEvent.setup();
    renderShell();
    const drawer = await openApprovals(user);
    await within(drawer).findByText("Research");
    const section = (name: string) => {
      const heading = within(drawer).getByRole("heading", { name });
      const element = heading.closest("section");
      if (element === null) throw new Error(`no section for ${name}`);
      return within(element);
    };

    expect(
      section("Core platform").getByText(/You cannot see Core platform/)
        .textContent,
    ).toContain("approvals.read");
    // A refused pending read shows no truncation notice.
    expect(
      section("Core platform").queryByText(/More approvals are waiting/),
    ).toBeNull();

    expect(
      section("Billing ops").getByText("No approvals waiting"),
    ).toBeTruthy();
    expect(
      section("Billing ops").getByText(
        /Resolved approvals could not be loaded: the control plane answered resolved_unavailable/,
      ),
    ).toBeTruthy();

    expect(
      section("Research").getByText(
        "More approvals are waiting than this list can show.",
      ),
    ).toBeTruthy();
    expect(
      section("Research").getByText("1 resolved today (UTC)"),
    ).toBeTruthy();
    expect(within(drawer).queryByText("No accessible workspaces")).toBeNull();
  });

  it("says so when the viewer has no accessible workspaces", async () => {
    actions.readShellActivity.mockResolvedValue(activity({ workspaces: [] }));
    const user = userEvent.setup();
    renderShell();
    const drawer = await openApprovals(user);
    expect(
      await within(drawer).findByText("No accessible workspaces"),
    ).toBeTruthy();
  });

  it("opens one approval in the panel with its workspace's mandates and returns to the list", async () => {
    const mandate = { id: "mdt_1", name: "Release" };
    actions.readShellActivity.mockResolvedValue(
      activity({
        workspaces: [
          workspace({
            pending: ok({
              items: [
                pendingItem(),
                pendingItem({ id: "apr_2", tool: "merge_pr" }),
              ],
              more: false,
            }),
            mandates: ok({ mandates: [mandate] }),
          }),
        ],
      }),
    );
    const user = userEvent.setup();
    renderShell();
    const drawer = await openApprovals(user);
    await user.click(
      await within(drawer).findByRole("button", { name: /merge_pr/ }),
    );

    expect(await within(drawer).findByText("Approval detail")).toBeTruthy();
    expect(within(drawer).getByText("Core platform")).toBeTruthy();
    expect(within(drawer).queryByRole("list")).toBeNull();
    const props = panel.calls.at(-1);
    expect(props?.org).toBe("acme");
    expect(props?.ws).toBe("core-platform");
    expect(props?.now).toBe(Date.parse("2026-09-23T00:00:00Z"));
    expect(props?.approvals).toEqual(
      readOk({
        items: [pendingItem({ id: "apr_2", tool: "merge_pr" })],
        more: false,
      }),
    );
    expect([...(props?.mandates ?? new Map()).entries()]).toEqual([
      ["mdt_1", mandate],
    ]);

    await user.click(
      within(drawer).getByRole("button", { name: "All approvals" }),
    );
    expect(await within(drawer).findByRole("list")).toBeTruthy();
    expect(within(drawer).queryByText("Approval detail")).toBeNull();
  });

  it("hands the panel no mandates when the workspace's mandate read was refused", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity({
        workspaces: [
          workspace({
            mandates: {
              ok: false,
              reason: "denied",
              permission: "mandates.read",
            },
          }),
        ],
      }),
    );
    const user = userEvent.setup();
    renderShell();
    const drawer = await openApprovals(user);
    await user.click(
      await within(drawer).findByRole("button", { name: /deploy_service/ }),
    );
    await within(drawer).findByText("Approval detail");
    expect(panel.calls.at(-1)?.mandates.size).toBe(0);
  });

  it("re-reads the activity when the panel resolves the approval and returns to the list once it leaves the queue", async () => {
    const user = userEvent.setup();
    actions.readShellActivity.mockResolvedValue(activity());
    renderShell();
    const drawer = await openApprovals(user);
    await user.click(
      await within(drawer).findByRole("button", { name: /deploy_service/ }),
    );
    await within(drawer).findByText("Approval detail");
    const calls = actions.readShellActivity.mock.calls.length;

    actions.readShellActivity.mockResolvedValue(
      activity({
        workspaces: [workspace({ pending: ok({ items: [], more: false }) })],
      }),
    );
    await act(async () => {
      panel.calls.at(-1)?.onResolved?.();
      await Promise.resolve();
    });

    expect(
      await within(drawer).findByText("No approvals waiting"),
    ).toBeTruthy();
    expect(actions.readShellActivity.mock.calls.length).toBe(calls + 1);
    expect(within(drawer).queryByText("Approval detail")).toBeNull();
  });

  it("re-reads the activity on Refresh", async () => {
    const user = userEvent.setup();
    renderShell();
    const drawer = await openApprovals(user);
    await within(drawer).findByText("Core platform");
    expect(actions.readShellActivity).toHaveBeenCalledTimes(1);
    expect(actions.readShellActivity).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );

    await user.click(within(drawer).getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(actions.readShellActivity).toHaveBeenCalledTimes(2);
    });
  });

  it("alerts when a refresh fails, keeps the last read, and clears the alert on the next success", async () => {
    const user = userEvent.setup();
    renderShell();
    const drawer = await openApprovals(user);
    await within(drawer).findByText("Core platform");

    actions.readShellActivity.mockRejectedValueOnce(new Error("network"));
    await user.click(within(drawer).getByRole("button", { name: "Refresh" }));
    expect((await within(drawer).findByRole("alert")).textContent).toBe(
      "Activity could not be refreshed. Try again.",
    );
    expect(within(drawer).getByText("Core platform")).toBeTruthy();

    await user.click(within(drawer).getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(within(drawer).queryByRole("alert")).toBeNull();
    });
  });

  it("re-reads every 30 seconds while open and stops once closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderShell();
    await screen.findByLabelText("2 unread notifications");
    const drawer = await openApprovals(user);
    await within(drawer).findByText("Core platform");
    expect(actions.readShellActivity).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(actions.readShellActivity).toHaveBeenCalledTimes(2);

    await closeDrawer(user, drawer);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(actions.readShellActivity).toHaveBeenCalledTimes(2);
  });

  it("drops a detailed read that answers after the drawer closed", async () => {
    const late = deferred<unknown>();
    actions.readShellActivity.mockReturnValueOnce(late.promise);
    const user = userEvent.setup();
    renderShell();
    await screen.findByLabelText("2 unread notifications");
    await closeDrawer(user, await openApprovals(user));
    await act(async () => {
      late.resolve(activity());
      await Promise.resolve();
    });

    const next = deferred<unknown>();
    actions.readShellActivity.mockReturnValueOnce(next.promise);
    const drawer = await openApprovals(user);
    // The late answer was never kept, so the reopened drawer waits for its own.
    expect(within(drawer).getByRole("status").textContent).toBe(
      "Loading activity",
    );
    expect(within(drawer).queryByText("Core platform")).toBeNull();
    await act(async () => {
      next.resolve(activity());
      await Promise.resolve();
    });
    expect(await within(drawer).findByText("Core platform")).toBeTruthy();
  });

  it("raises no alert for a detailed read that fails after the drawer closed", async () => {
    const late = deferred<unknown>();
    actions.readShellActivity.mockReturnValueOnce(late.promise);
    const user = userEvent.setup();
    renderShell();
    await screen.findByLabelText("2 unread notifications");
    await closeDrawer(user, await openApprovals(user));
    await act(async () => {
      late.reject(new Error("network"));
      await Promise.resolve();
    });

    const next = deferred<unknown>();
    actions.readShellActivity.mockReturnValueOnce(next.promise);
    const drawer = await openApprovals(user);
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });
});

describe("notifications drawer", () => {
  it("shows a loading status until the detailed read answers", async () => {
    actions.readShellActivity.mockReturnValue(deferred<unknown>().promise);
    const user = userEvent.setup();
    renderShell();
    const drawer = await openNotifications(user);
    expect(within(drawer).getByRole("status").textContent).toBe(
      "Loading activity",
    );
  });

  it("shows the read's refusal in place of the list", async () => {
    actions.readShellActivity.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "notifications.read",
    });
    const user = userEvent.setup();
    renderShell();
    const drawer = await openNotifications(user);
    const failure = await within(drawer).findByText(/notifications\.read/);
    // Wart pinned as found: the notifications drawer shares the approvals
    // drawer's status, so a refused read here names the section "Approvals".
    expect(failure.textContent).toContain("You cannot see Approvals");
    expect(within(drawer).queryByText("No notifications")).toBeNull();
  });

  it("lists notifications with their unread mark, body and actions", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity({
        notifications: {
          items: [
            notice(
              {
                publicId: "ntf_1",
                title: "Approval waiting",
                body: "deploy_service needs a decision",
                deepLink: "/acme/core-platform/runs/run_1",
                unread: true,
              },
              "core-platform",
            ),
            notice({ publicId: "ntf_2", title: "Budget reached" }),
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderShell();
    const drawer = await openNotifications(user);
    const items = within(await within(drawer).findByRole("list")).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(2);

    const [first, second] = items.map((item) => within(item));
    expect(first?.getByRole("heading").textContent).toBe("Approval waiting");
    expect(first?.getByText("deploy_service needs a decision")).toBeTruthy();
    expect(
      first?.getByRole("link", { name: "Open" }).getAttribute("href"),
    ).toBe("/acme/core-platform/runs/run_1");
    expect(first?.getByRole("button", { name: "Mark read" })).toBeTruthy();
    expect(first?.getByRole("button", { name: "Archive" })).toBeTruthy();

    // A read notification without a body or link offers only Archive.
    expect(second?.getByRole("heading").textContent).toBe("Budget reached");
    expect(second?.queryByRole("link")).toBeNull();
    expect(second?.queryByRole("button", { name: "Mark read" })).toBeNull();
    expect(second?.getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(items[1]?.querySelectorAll("p")).toHaveLength(0);

    expect(
      within(drawer).queryByText(/Some notifications are unavailable/),
    ).toBeNull();
    await expectNoAxe(document.body);
  });

  it("closes the drawer when a notification's link is followed", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity({
        notifications: {
          items: [notice({ deepLink: "/acme/core-platform/runs/run_1" })],
        },
      }),
    );
    const user = userEvent.setup();
    renderShell();
    const drawer = await openNotifications(user);
    await user.click(await within(drawer).findByRole("link", { name: "Open" }));
    await waitFor(() => {
      expect(screen.queryByTestId("notifications-drawer")).toBeNull();
    });
  });

  it("points a link that leaves the app at the organization page instead", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity({
        notifications: {
          items: [notice({ deepLink: "https://evil.example/phish" })],
        },
      }),
    );
    const user = userEvent.setup();
    renderShell();
    const drawer = await openNotifications(user);
    expect(
      (await within(drawer).findByRole("link", { name: "Open" })).getAttribute(
        "href",
      ),
    ).toBe("/acme");
  });

  it("says there are none and names each refused scope and a partial read", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity({
        notifications: {
          items: [],
          partial: true,
          failures: [
            {
              ws: null,
              read: {
                ok: false,
                reason: "error",
                code: "notifications_unavailable",
                status: 503,
              },
            },
            {
              ws: "billing-ops",
              read: {
                ok: false,
                reason: "denied",
                permission: "notifications.read",
              },
            },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderShell();
    const drawer = await openNotifications(user);
    expect(await within(drawer).findByText("No notifications")).toBeTruthy();
    // An organization-level failure is named by the drawer's title.
    expect(
      within(drawer).getByText(
        /^Notifications could not be loaded: the control plane answered notifications_unavailable/,
      ),
    ).toBeTruthy();
    // A workspace failure is named by the workspace's slug.
    expect(
      within(drawer).getByText(/^You cannot see billing-ops in this workspace/)
        .textContent,
    ).toContain("notifications.read");
    expect(
      within(drawer).getByText(
        "Some notifications are unavailable or outside this page. Counts cover the loaded records.",
      ),
    ).toBeTruthy();
  });

  it("marks a workspace notification read in its workspace, disables the actions meanwhile, then re-reads", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity({
        notifications: {
          items: [notice({ publicId: "ntf_1", unread: true }, "core-platform")],
        },
      }),
    );
    const answer = deferred<unknown>();
    actions.markShellNotification.mockReturnValue(answer.promise);
    const user = userEvent.setup();
    renderShell();
    const drawer = await openNotifications(user);
    await user.click(
      await within(drawer).findByRole("button", { name: "Mark read" }),
    );

    expect(actions.markShellNotification).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "ntf_1",
      false,
    );
    expect(
      within(drawer).getByRole("button", { name: "Mark read" }),
    ).toBeDisabled();
    expect(
      within(drawer).getByRole("button", { name: "Archive" }),
    ).toBeDisabled();
    const reads = actions.readShellActivity.mock.calls.length;

    await act(async () => {
      answer.resolve(ok({ ok: true }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        within(drawer).getByRole("button", { name: "Archive" }),
      ).toBeEnabled();
    });
    expect(actions.readShellActivity.mock.calls.length).toBe(reads + 1);
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });

  it("archives an organization notification in the organization scope", async () => {
    actions.readShellActivity.mockResolvedValue(
      activity({ notifications: { items: [notice({ publicId: "ntf_2" })] } }),
    );
    actions.markShellNotification.mockResolvedValue(ok({ ok: true }));
    const user = userEvent.setup();
    renderShell();
    const drawer = await openNotifications(user);
    await user.click(
      await within(drawer).findByRole("button", { name: "Archive" }),
    );
    expect(actions.markShellNotification).toHaveBeenCalledWith(
      "acme",
      null,
      "ntf_2",
      true,
    );
  });

  it.each([
    [
      "the action is refused",
      () =>
        Promise.resolve({
          ok: false,
          reason: "denied",
          code: "notifications.mark",
        }),
    ],
    ["the store reports no change", () => Promise.resolve(ok({ ok: false }))],
    ["the call throws", () => Promise.reject(new Error("network"))],
  ])(
    "alerts without re-reading when %s, and clears the alert on the next attempt",
    async (_, answer) => {
      actions.readShellActivity.mockResolvedValue(
        activity({
          notifications: {
            items: [
              notice({ publicId: "ntf_1", unread: true }, "core-platform"),
            ],
          },
        }),
      );
      actions.markShellNotification.mockImplementationOnce(answer);
      const user = userEvent.setup();
      renderShell();
      const drawer = await openNotifications(user);
      await user.click(
        await within(drawer).findByRole("button", { name: "Mark read" }),
      );
      expect((await within(drawer).findByRole("alert")).textContent).toBe(
        "Activity could not be refreshed. Try again.",
      );
      expect(actions.readShellActivity).toHaveBeenCalledTimes(1);
      expect(
        within(drawer).getByRole("button", { name: "Mark read" }),
      ).toBeEnabled();

      const retry = deferred<unknown>();
      actions.markShellNotification.mockReturnValueOnce(retry.promise);
      await user.click(
        within(drawer).getByRole("button", { name: "Mark read" }),
      );
      expect(within(drawer).queryByRole("alert")).toBeNull();
    },
  );
});
